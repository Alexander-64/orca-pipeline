import { realpathSync } from 'node:fs'
import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPi } from '../pi-adapter/session'
import { runCommandExecutor } from './executor'
import { checkCommand, type CheckResult } from './acceptance'
import { atomicJson } from './files'
import { classifyFailure, redactSecrets, redactValue } from '../core/failover'
import type { Executor } from './config'
import type { CommandPolicy, OutputSchema, StructuredData, ReviewResult, FailureInfo, ScenarioStep } from '../core/types'
import { resultFromText, validateResult } from '../core/results'
import { reviewFromText, validateReview } from '../core/review'
import { WorkerMailbox } from './mailbox'
import { currentBootId } from './process-lifetime'

export type WorkerRequest = {
  id: string; cancelToken: string; cwd: string; prompt: string; executor: Executor
  acceptance: string[]; policy?: CommandPolicy; timeoutMs?: number
  generation?: number; resumeSessionFile?: string
  outputSchema?: OutputSchema
  role?: ScenarioStep['role']
}
export type WorkerResult = {
  id: string; outcome: 'succeeded' | 'failed' | 'cancelled'; text: string
  checks: CheckResult[]; sessionFile?: string; finishedAt: string
  data?: StructuredData
  dataVersion?: 1
  review?: ReviewResult; failure?: FailureInfo; filesModified?: string[]; uncertainFiles?: string[]
}

export async function workerMain(requestPath: string): Promise<void> {
  const request: WorkerRequest = JSON.parse(await readFile(requestPath, 'utf8'))
  const directory = dirname(requestPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await atomicJson(join(directory, 'started.json'), { id: request.id, generation: request.generation ?? 0, pid: process.pid, bootId: currentBootId(), at: new Date().toISOString() })
  const abort = new AbortController()
  let writes = Promise.resolve(), seq = 0
  let generatedCharacters = 0, lastProgressAt = 0
  if (request.resumeSessionFile) {
    const previous = await readFile(join(directory, 'events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    for (const line of previous.split('\n')) { try { const event = JSON.parse(line); if (event.id === request.id && Number.isSafeInteger(event.seq)) seq = Math.max(seq, event.seq) } catch {} }
  }
  const onEvent = (event: { kind: string; text?: string; tool?: string }) => {
    if (event.kind === 'text.delta') {
      generatedCharacters += event.text?.length ?? 0
      if (Date.now() - lastProgressAt < 1000) return
      lastProgressAt = Date.now()
      // Token fragments can split credentials across events. Persist progress counts;
      // the complete report is redacted as one value before it enters results/artifacts.
      event = { kind: 'text.progress', text: `${generatedCharacters} characters generated` }
    }
    const entry = { ...event, ...(event.text ? { text: event.text.slice(0, 8000) } : {}), seq: ++seq, at: new Date().toISOString(), id: request.id }
    writes = writes.then(() => appendFile(join(directory, 'events.jsonl'), JSON.stringify(redactValue(entry)) + '\n', { mode: 0o600 }))
  }
  const mailbox = new WorkerMailbox(directory, request.cancelToken, onEvent)
  await mailbox.start()
  await atomicJson(join(directory, 'phase.json'), { id: request.id, phase: 'preparing' })
  let checkingCancel = false
  const interval = setInterval(() => {
    if (checkingCancel) return
    checkingCancel = true
    void readFile(join(directory, 'cancel.json'), 'utf8').then(source => {
      const cancellation = JSON.parse(source)
      if (cancellation.id === request.id && cancellation.token === request.cancelToken) abort.abort()
    }).catch(() => {}).finally(() => { checkingCancel = false })
  }, 200)
  const timeout = setTimeout(() => { onEvent({ kind: 'worker.timeout' }); abort.abort() }, request.timeoutMs ?? 1_800_000)
  process.once('SIGTERM', () => abort.abort())
  process.once('SIGINT', () => abort.abort())
  const checks: CheckResult[] = []
  let text = '', sessionFile: string | undefined, outcome: WorkerResult['outcome'] = 'failed'
  let data: StructuredData | undefined
  let review: ReviewResult | undefined, failure: FailureInfo | undefined
  let filesModified: string[] | undefined, uncertainFiles: string[] | undefined
  let phase: FailureInfo['phase'] = 'executor'
  try {
    onEvent({ kind: request.resumeSessionFile ? 'worker.resumed' : 'worker.started' })
    const response = request.executor.kind === 'pi'
      ? await runPi({ cwd: request.cwd, prompt: request.prompt, sessionDir: join(directory, 'sessions'), readOnly: request.policy?.readOnly === true || request.role === 'evidence', evidence: request.role === 'evidence', provider: request.executor.provider, model: request.executor.model, signal: abort.signal, onEvent,
        onReady: controls => { mailbox.setControls(controls); void atomicJson(join(directory, 'phase.json'), { id: request.id, phase: 'agent' }).catch(() => abort.abort()) },
        onQuestion: (question, signal, toolCallId) => mailbox.ask(question, signal, toolCallId), onQuestionDelivered: id => mailbox.deliveredQuestion(id), onMessageDelivered: id => mailbox.delivered(id),
        onSession: file => atomicJson(join(directory, 'session.json'), { id: request.id, file }), resumeSessionFile: request.resumeSessionFile, outputSchema: request.outputSchema })
      : await runCommandExecutor(request.executor, request.cwd, request.prompt, request.policy?.readOnly === true || request.role === 'evidence', abort.signal, onEvent)
    text = response.text; sessionFile = response.sessionFile
    if ('filesModified' in response && Array.isArray(response.filesModified)) filesModified = response.filesModified.filter((file): file is string => typeof file === 'string')
    if ('uncertainFiles' in response && Array.isArray(response.uncertainFiles)) uncertainFiles = response.uncertainFiles.filter((file): file is string => typeof file === 'string')
    phase = 'validation'
    if (request.outputSchema) data = 'data' in response && response.data ? validateResult(request.outputSchema, response.data) : resultFromText(request.outputSchema, text)
    if (request.role === 'evidence') {
      review = 'review' in response && response.review ? validateReview(response.review) : reviewFromText(text)
      text = `${review.verdict}\n${review.findings}\n\n${text}`
    }
    await atomicJson(join(directory, 'phase.json'), { id: request.id, phase: 'acceptance' })
    await mailbox.close()
    phase = 'acceptance'
    for (const command of request.acceptance) {
      if (abort.signal.aborted) throw new Error('Cancelled before acceptance')
      onEvent({ kind: 'acceptance.started', text: command })
      const check = await checkCommand(command, request.cwd, request.policy, abort.signal)
      checks.push(check)
      onEvent({ kind: 'acceptance.finished', text: JSON.stringify(check) })
      if (check.exitCode !== 0) throw new Error(`Acceptance failed: ${command} (exit ${check.exitCode})`)
    }
    if (abort.signal.aborted) throw new Error('Cancelled')
    if (review && review.verdict !== 'SHIP') { phase = 'review'; throw new Error('Evidence verdict: ' + review.verdict) }
    outcome = 'succeeded'
  } catch (error) {
    outcome = abort.signal.aborted ? 'cancelled' : 'failed'
    const message = redactSecrets(error instanceof Error ? error.message : String(error))
    if (error instanceof Error && 'failurePhase' in error && error.failurePhase === 'validation') phase = 'validation'
    failure = { version: 1, phase: abort.signal.aborted ? 'cancellation' : phase, kind: !abort.signal.aborted && phase === 'executor' ? classifyFailure(message) : 'unknown', message }
    if (error instanceof Error && 'filesModified' in error && Array.isArray(error.filesModified)) filesModified = error.filesModified.filter((file): file is string => typeof file === 'string')
    if (error instanceof Error && 'uncertainFiles' in error && Array.isArray(error.uncertainFiles)) uncertainFiles = error.uncertainFiles.filter((file): file is string => typeof file === 'string')
    if (error instanceof Error && 'partialText' in error && typeof error.partialText === 'string') text = '# Incomplete result — worker did not succeed\n\n' + error.partialText
    text = [text, redactSecrets(error instanceof Error ? error.message : String(error))].filter(Boolean).join('\n\n')
  } finally { clearInterval(interval); clearTimeout(timeout); await mailbox.close() }
  const result: WorkerResult = { id: request.id, outcome, text, checks, sessionFile, finishedAt: new Date().toISOString(), ...(data ? { data, dataVersion: 1 } : {}), review, failure, filesModified, uncertainFiles }
  onEvent({ kind: 'worker.finished', text: outcome })
  await writes
  await writeFile(join(directory, 'report.md'), text + '\n', { mode: 0o600 })
  await atomicJson(join(directory, 'phase.json'), { id: request.id, phase: 'finished' })
  await atomicJson(join(directory, 'result.json'), result)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) void workerMain(process.argv[2]).catch(error => { console.error(redactSecrets(error.message)); process.exitCode = 1 })
