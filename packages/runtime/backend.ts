import { stepForAgent } from '../core/agent-preferences'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat, open, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutionBackend } from '../core/contracts'
import type { PipelineRun, Scenario, ScenarioStep } from '../core/types'
import { taskSpec } from '../core/scenario'
import { waves } from '../core/editor'
import { validateLocalCommand } from './acceptance'
import { atomicJson } from './files'
import { RunStore } from './store'
import type { RuntimeConfig } from './config'
import type { WorkerRequest, WorkerResult } from './worker-main'
import { enqueueMessage, interactions, validateUserMessage } from './mailbox'
import type { MessageReceipt, UserMessage, WorkerQuestion } from '../core/types'
import { resultInstructions } from '../core/results'
import { reviewInstructions, failureInfo } from '../core/review'
import { processExited } from './process-lifetime'

type TaskRecord = { id: string; runId: string; step: ScenarioStep; spec: string; dependencies: string[]; attempt?: string; result?: WorkerResult; status: string }
type AttemptRecord = { id: string; taskId: string; runId: string; directory: string; agent: string; provider?: string; cancelToken: string; startedAt: string; stage: 'intent' | 'launched' | 'finished'; eventSeq: number; eventOffset?: number; result?: WorkerResult; generation?: number; recovery?: { generation: number; state: 'intent' | 'launched'; at: string } }
type GateRecord = { id: string; runId: string; taskId: string; question: string; status: string; resolution?: string }

async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

// ESRCH is proof of exit. A live/reused PID, EPERM, or missing receipt is ambiguous.
export function verifiedProcessExit(pid: number, bootId?: string): boolean { return processExited(pid, bootId) }

export class LocalBackend implements ExecutionBackend {
  creationRequestId?: string
  private resolvedConfig: RuntimeConfig
  constructor(readonly store: RunStore, readonly project: string, readonly config: RuntimeConfig) { this.resolvedConfig = structuredClone(config) }

  preflightScenario(scenario: Scenario): Promise<void> { return this.preflight(scenario) }

  canStart(run: PipelineRun, _step: ScenarioStep, agent: string): boolean {
    const active = this.store.list<AttemptRecord>('attempt:').filter(attempt => !attempt.result)
    if (active.filter(attempt => attempt.runId === run.runId).length >= (run.scenario.maxConcurrent ?? 3)) return false
    if (!run.scenario.commandPolicy?.readOnly && active.length > 0) return false
    if (run.scenario.commandPolicy?.readOnly && active.some(attempt => !this.store.list<PipelineRun>('run:').find(candidate => candidate.runId === attempt.runId)?.scenario.commandPolicy?.readOnly)) return false
    const executors = this.store.get<RuntimeConfig>('execution:' + run.runId)?.executors ?? this.resolvedConfig.executors
    const providerOf = (name: string) => executors[name]?.provider ?? executors[name]?.kind ?? name
    const provider = providerOf(agent)
    const limit = run.scenario.providerLimits?.[provider]
    return limit === undefined || active.filter(attempt => (attempt.provider ?? providerOf(attempt.agent)) === provider).length < limit
  }

  async preflight(scenario: Scenario): Promise<void> {
    if (scenario.pullRequest) throw new Error('Local backend does not yet support pullRequest; select Orca explicitly')
    for (const step of scenario.steps) {
      if (step.placement.host !== 'local' || step.placement.worktree !== 'current') throw new Error(`Unsupported local placement: ${step.id}`)
      if (step.effort) throw new Error(`Explicit effort is not yet supported by local executors: ${step.id}`)
      for (const agent of [step.agent, ...step.fallback]) {
        if (!this.config.executors[agent]) throw new Error(`Executor ${agent} is not configured; no automatic substitution`)
        if (this.config.executors[agent].kind === 'orca') throw new Error(`Executor ${agent} requires the Orca backend; no local substitution`)
      }
      if (scenario.commandPolicy?.allowedCommands && !scenario.commandPolicy.readOnly && [step.agent, ...step.fallback].some(agent => this.config.executors[agent].kind === 'codex')) throw new Error('Codex workspace-write cannot enforce allowedCommands; select a controlled executor')
      for (const command of step.acceptance) validateLocalCommand(command, scenario.commandPolicy)
    }
    const used = new Set(scenario.steps.flatMap(step => [step.agent, ...step.fallback]))
    for (const agent of used) {
      const executor = this.config.executors[agent]
      if (executor.kind !== 'pi') continue
      const { resolvePiModel } = await import('../pi-adapter/session')
      const { model } = await resolvePiModel(this.project, executor.provider, executor.model)
      this.resolvedConfig.executors[agent] = { ...executor, provider: model.provider, model: model.id }
      for (const step of scenario.steps.filter(step => [step.agent, ...step.fallback].includes(agent)).map(step => stepForAgent(step, agent)).filter(step => step.model)) await resolvePiModel(this.project, model.provider, step.model)
    }
    // Independent read-only tasks can run together; writing one checkout is serialized by runtime.
  }

  async createRun(objective: string, owner: string): Promise<string> {
    const id = randomUUID(); this.store.put('native-run:' + id, { id, objective, owner, requestId: this.creationRequestId, backend: 'local' }); this.store.put('execution:' + id, this.resolvedConfig); return id
  }
  async bindRun(runId: string, owner: string): Promise<void> {
    if (!this.store.get('native-run:' + runId)) throw new Error('Run does not exist')
    this.store.event('run.bound', { runId, owner })
  }
  async reconcile(run: PipelineRun): Promise<void> {
    const origin = this.store.get<{ requestId?: string }>('native-run:' + run.runId)
    if (origin?.requestId && !this.store.get('snapshot:' + run.id)) {
      const snapshot = this.store.get('plan-snapshot:' + origin.requestId)
      if (snapshot) this.store.put('snapshot:' + run.id, snapshot)
    }
    // Recover the gap between a durable backend launch receipt and Coordinator.save().
    for (const step of waves(run.scenario.steps).flat()) {
      let task = run.tasks[step.id]
      if (task?.revisionPending) continue
      if (!task) {
        const id = await this.createTask(run.runId, run.coordinatorHandle, step, taskSpec(step, undefined, run.runId, run.scenario.version === 2), run.scenario.version === 2 ? [] : step.needs.map(id => run.tasks[id].taskId))
        task = run.tasks[step.id] = { stepId: step.id, taskId: id, status: 'pending', agent: step.agent, attempts: [] }
      }
      const native = this.store.get<TaskRecord>('task:' + task.taskId)
      if (native?.attempt && (!task.attempts.some(attempt => attempt.dispatchId === native.attempt) || task.unconfirmedStart)) {
        let receipt = this.store.get<AttemptRecord>('attempt:' + native.attempt)
        if (!receipt) throw new Error('Task references a missing attempt receipt')
        receipt = await this.refresh(receipt)
        if (receipt.stage === 'intent') {
          const started = await json<{ id: string }>(join(receipt.directory, 'started.json'))
          if (started?.id !== receipt.id) throw new Error('Local startup is unconfirmed; no replacement was started')
          receipt.stage = 'launched'; this.store.put('attempt:' + receipt.id, receipt)
        }
        if (!task.attempts.some(attempt => attempt.dispatchId === receipt!.id)) task.attempts.push({ dispatchId: receipt.id, taskId: task.taskId, agent: receipt.agent, status: 'running', startedAt: receipt.startedAt })
        task.unconfirmedStart = undefined
        task.retryRequested = undefined
        task.error = undefined; task.waitReason = undefined; task.activityObservedAt = undefined
        task.agent = receipt.agent; task.status = 'running'
      }
    }
    this.store.put('run:' + run.id, run, 'run.reconciled', { id: run.id })
  }
  async createTask(runId: string, _owner: string, step: ScenarioStep, spec: string, dependencies: string[]): Promise<string> {
    const id = createHash('sha256').update(runId + ':' + step.id).digest('hex').slice(0, 32)
    if (!this.store.get('task:' + id)) this.store.put('task:' + id, { id, runId, step, spec, dependencies, status: 'pending' } satisfies TaskRecord)
    return id
  }
  reviseTask(run: PipelineRun, step: ScenarioStep, revision: number, spec: string, dependencies: string[]): Promise<string> {
    return this.createTask(run.runId, run.coordinatorHandle, { ...step, id: step.id + '.revision.' + revision }, spec, dependencies)
  }

  async refresh(attempt: AttemptRecord): Promise<AttemptRecord> {
    const result = await json<WorkerResult>(join(attempt.directory, 'result.json'))
    if (result && result.id !== attempt.id) throw new Error('Attempt receipt identity mismatch')
    if (!attempt.result && result) {
      attempt.result = result; attempt.stage = 'finished'
      this.store.put('attempt:' + attempt.id, attempt, 'attempt.finished', { id: attempt.id, taskId: attempt.taskId, outcome: result.outcome })
      const task = this.store.get<TaskRecord>('task:' + attempt.taskId)!
      if (task.attempt === attempt.id) {
        task.result = result; task.status = result.outcome === 'succeeded' ? 'completed' : 'failed'
        this.store.put('task:' + task.id, task)
      }
    }
    try {
      const file = await open(join(attempt.directory, 'events.jsonl'), 'r')
      const buffer = Buffer.alloc(128_000)
      let bytesRead: number
      try { bytesRead = (await file.read(buffer, 0, buffer.length, attempt.eventOffset ?? 0)).bytesRead }
      finally { await file.close() }
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10)
      const events = end < 0 ? [] : buffer.subarray(0, end + 1).toString('utf8').split('\n')
      let last = attempt.eventSeq
      for (const source of events) {
        if (!source) continue
        let event: { seq: number; kind: string; id: string }
        try { event = JSON.parse(source) } catch { break } // A currently incomplete last write is retried.
        if (event.id !== attempt.id || event.seq <= attempt.eventSeq) continue
        this.store.eventOnce(`${attempt.id}:${event.seq}`, 'worker.event', { ...event, taskId: attempt.taskId }); last = event.seq
      }
      if (end >= 0) {
        attempt.eventSeq = last; attempt.eventOffset = (attempt.eventOffset ?? 0) + end + 1
        this.store.put('attempt:' + attempt.id, attempt)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return attempt
  }

  async listTasks(runId: string): Promise<Record<string, unknown>[]> {
    const tasks = this.store.list<TaskRecord>('task:').filter(task => task.runId === runId)
    for (const task of tasks) if (task.attempt) await this.refresh(this.store.get<AttemptRecord>('attempt:' + task.attempt)!)
    const current = this.store.list<TaskRecord>('task:').filter(task => task.runId === runId)
    return current.map(task => ({ ...task, result: task.result?.outcome === 'failed' && !failureInfo(task.result.failure) ? { ...task.result, failure: { version: 1, phase: task.result.checks?.some(check => check.exitCode !== 0) ? 'acceptance' : 'executor', kind: 'unknown', message: 'Unversioned worker error; automatic provider classification is unavailable' } } : task.result, status: task.status === 'pending' && task.dependencies.every(id => current.some(other => other.id === id && other.status === 'completed')) ? 'ready' : task.status }))
  }

  async skipTask(runId: string, _owner: string, taskId: string, reason: string): Promise<void> {
    const task = this.store.get<TaskRecord>('task:' + taskId)
    if (!task || task.runId !== runId || task.attempt) throw new Error('Cannot skip an active or foreign task')
    task.status = 'skipped'; this.store.put('task:' + taskId, task, 'task.skipped', { taskId, reason })
  }

  async prepareCheckpoint(run: PipelineRun, _step: ScenarioStep, taskId: string, body: string): Promise<void> {
    const task = this.store.get<TaskRecord>('task:' + taskId)
    if (!task || task.runId !== run.runId) throw new Error('Checkpoint task ownership mismatch')
    this.store.put('checkpoint:' + taskId, body, 'checkpoint.prepared', { taskId })
  }

  async startWorker(run: PipelineRun, step: ScenarioStep, taskId: string, agent: string, retryOf?: string): Promise<string> {
    const id = createHash('sha256').update(`${taskId}:${retryOf ?? 'initial'}:${agent}`).digest('hex').slice(0, 32)
    const previous = this.store.get<AttemptRecord>('attempt:' + id)
    if (previous) {
      // The durable intent is authoritative, including ambiguous startup. Never spawn it twice.
      if (previous.stage === 'intent') throw Object.assign(new Error(`Unknown startup ${id}; reconcile before retrying`), { startOutcome: 'unknown' })
      return id
    }
    const executor = this.store.get<RuntimeConfig>('execution:' + run.runId)?.executors[agent] ?? this.resolvedConfig.executors[agent]
    if (!executor) throw new Error(`Unconfigured executor: ${agent}`)
    const directory = join(this.project, '.agent-pipeline', 'runtime', 'attempts', id)
    const attempt: AttemptRecord = { id, taskId, runId: run.runId, directory, agent, provider: executor.provider ?? executor.kind, cancelToken: randomUUID(), startedAt: new Date().toISOString(), stage: 'intent', eventSeq: 0 }
    this.store.put('attempt:' + id, attempt, 'attempt.intent', { id, taskId, agent })
    const task = this.store.get<TaskRecord>('task:' + taskId)!
    task.attempt = id; task.result = undefined; task.status = 'dispatched'
    this.store.put('task:' + taskId, task)
    const dependencies = step.needs.map(id => ({ core: run.tasks[id], task: this.store.get<TaskRecord>('task:' + run.tasks[id]?.taskId) }))
    const checkpoint = this.store.get<string>('checkpoint:' + taskId) ?? (retryOf ? this.store.get<AttemptRecord>('attempt:' + retryOf)?.result?.text : undefined)
    const prompt = [
      `Task: ${step.title}\n${step.spec}`,
      'Follow AGENTS.md and README in the project. Do not commit, push, send external messages, or modify previous reports. Return your complete report as the final answer. Acceptance commands are executed independently by the runtime.',
      run.scenario.commandPolicy?.readOnly ? 'Read-only analysis. Do not change project files.' : '',
      step.outputSchema ? resultInstructions(step.outputSchema) : '',
      step.role === 'evidence' ? reviewInstructions : '',
      ...dependencies.map(({ core, task }) => `Predecessor ${core?.stepId} (${core?.status}):\nValidated data: ${JSON.stringify(core?.data ?? null)}\n${core?.skipReason ?? task?.result?.text?.slice(-24_000) ?? 'No report'}`),
      checkpoint ? `Previous attempt checkpoint:\n${checkpoint.slice(-24_000)}` : ''
    ].filter(Boolean).join('\n\n')
    const request: WorkerRequest = { id, cancelToken: attempt.cancelToken, cwd: this.project, prompt, executor: { ...executor, ...(step.model ? { model: step.model } : {}) }, acceptance: step.acceptance, policy: run.scenario.commandPolicy, outputSchema: step.outputSchema, role: step.role }
    const path = join(directory, 'request.json')
    try { await atomicJson(path, request); await this.spawnWorker(path) }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { startOutcome: 'unknown' }) }
    attempt.stage = 'launched'; this.store.put('attempt:' + id, attempt, 'attempt.launched', { id, taskId })
    return id
  }

  protected async spawnWorker(path: string): Promise<void> {
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.mjs') ? './worker.mjs' : './worker-main.ts', import.meta.url))
    const args = entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), entry, path] : [entry, path]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: this.project, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }

  async recoverPi(id: string): Promise<void> {
    const attempt = await this.refresh(this.attempt(id))
    if (attempt.result) throw new Error('Worker already settled; recovery would repeat completed work')
    const requestPath = join(attempt.directory, 'request.json')
    const request = await json<WorkerRequest>(requestPath)
    if (request?.id !== id || request.executor.kind !== 'pi') throw new Error('Context recovery is supported only for Pi sessions')
    const started = await json<{ id: string; pid: number; bootId?: string; generation?: number }>(join(attempt.directory, 'started.json'))
    const generation = attempt.recovery?.generation ?? attempt.generation ?? 0
    if (started?.id !== id || (started.generation ?? 0) !== generation || !verifiedProcessExit(started.pid, started.bootId)) throw new Error('Previous worker exit is not verified; no replacement was started')
    if (await json(join(attempt.directory, 'cancel.json'))) throw new Error('Cancellation was requested; do not resume this session')
    const phase = await json<{ id: string; phase: string }>(join(attempt.directory, 'phase.json'))
    if (phase?.id !== id || (phase.phase !== 'agent' && phase.phase !== 'preparing')) throw new Error('Worker was running acceptance or finishing; recovery requires reconciliation, not replay')
    const session = await json<{ id: string; file: string }>(join(attempt.directory, 'session.json'))
    if (session?.id !== id) throw new Error('No persisted Pi session to recover')
    const root = await realpath(join(attempt.directory, 'sessions'))
    const file = await realpath(session.file)
    const rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep) || !(await stat(file)).isFile()) throw new Error('Session receipt points outside the attempt')
    const source = await readFile(file, 'utf8')
    const header = JSON.parse(source.split('\n')[0])
    if (header.type !== 'session' || await realpath(header.cwd) !== await realpath(this.project)) throw new Error('Session project identity mismatch')
    const nextGeneration = generation + 1
    // Intent precedes every spawn. A crash in this gap cannot spawn a second replacement.
    attempt.recovery = { generation: nextGeneration, state: 'intent', at: new Date().toISOString() }
    this.store.put('attempt:' + id, attempt, 'attempt.recovery-intent', { id, generation: nextGeneration, exitedPid: started.pid })
    const events = await readFile(join(attempt.directory, 'events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (events && !events.endsWith('\n')) {
      const end = events.lastIndexOf('\n') + 1
      await atomicJson(join(attempt.directory, `interrupted-event-tail-${nextGeneration}.json`), { text: events.slice(end) })
      const log = await open(join(attempt.directory, 'events.jsonl'), 'r+')
      try { await log.truncate(Buffer.byteLength(events.slice(0, end))); await log.sync() } finally { await log.close() }
    }
    const dialogue = await interactions(attempt.directory)
    for (const question of dialogue.questions) if (question.state === 'waiting') await atomicJson(join(attempt.directory, 'questions', question.id + '.json'), { ...question, state: 'cancelled' })
    request.generation = nextGeneration; request.resumeSessionFile = file
    request.prompt = 'This is an explicit recovery of the SAME interrupted Pipeline task. Continue from the saved session history. Previous tool actions may have completed; inspect current files before writing and do not repeat completed work. Unreturned user questions were cancelled; ask again if their answer is still necessary. Do not invent missing answers. Return the complete task report.\n\nOriginal assignment:\n' + request.prompt.split('\n\nOriginal assignment:\n').at(-1)
    await atomicJson(requestPath, request)
    await this.spawnWorker(requestPath)
    attempt.generation = nextGeneration; attempt.recovery.state = 'launched'
    this.store.put('attempt:' + id, attempt, 'attempt.recovered', { id, generation: nextGeneration, sessionFile: file })
  }

  async workerOutput(id: string): Promise<string> { return (await this.refresh(this.attempt(id))).result?.text ?? '' }
  async workerActivityDone(id: string): Promise<boolean> { return Boolean((await this.refresh(this.attempt(id))).result) }
  async workerFailure(id: string) {
    const result = (await this.refresh(this.attempt(id))).result
    return { settled: !!result, failure: result?.outcome === 'failed' ? failureInfo(result.failure) : undefined }
  }
  async settledResult(id: string): Promise<Record<string, unknown> | undefined> { const result = (await this.refresh(this.attempt(id))).result; return result ? { ...result } : undefined }
  observationIntervalMs(_id: string): number { return 1000 }
  async workerObservation(id: string): Promise<{ activity: string; waitReason?: string; workerState?: string; questions?: WorkerQuestion[]; messages?: MessageReceipt[]; interaction?: 'pi' | 'none' }> {
    const attempt = await this.refresh(this.attempt(id))
    const dialogue = await this.workerInteractions(id)
    const request = await json<WorkerRequest>(join(attempt.directory, 'request.json'))
    const interaction = request?.executor.kind === 'pi' ? 'pi' as const : 'none' as const
    if (attempt.result) return { activity: 'done', workerState: attempt.result.outcome, ...dialogue, interaction }
    const started = await json<{ id: string; pid: number; bootId?: string }>(join(attempt.directory, 'started.json'))
    if (started?.id === id && verifiedProcessExit(started.pid, started.bootId)) return { activity: 'interrupted', workerState: 'exited', waitReason: interaction === 'pi' ? 'Worker process exited without a result. Explicit Pi context recovery is available with pipeline recover.' : 'CLI process exited without a result; child process ownership must be reconciled before retry.', ...dialogue, interaction }
    const waiting = dialogue.questions.filter(question => question.state === 'waiting')
    if (waiting.length) return { activity: 'waiting-user', waitReason: waiting.map(question => `${question.id}: ${question.question}`).join('\n'), ...dialogue, interaction }
    const events = await stat(join(attempt.directory, 'events.jsonl')).catch(() => undefined)
    return { activity: events && Date.now() - events.mtimeMs < 15_000 ? 'observed' : 'unknown', waitReason: events ? undefined : 'Awaiting verified worker startup', ...dialogue, interaction }
  }
  async workerInteractions(id: string): Promise<{ questions: WorkerQuestion[]; messages: MessageReceipt[] }> {
    const attempt = this.attempt(id)
    const result = await interactions(attempt.directory)
    const sent = this.store.list<UserMessage & { attemptId: string; at: string }>('user-message:').filter(message => message.attemptId === id)
    for (const message of sent) if (!result.messages.some(receipt => receipt.id === message.id)) result.messages.push({ id: message.id, questionId: message.questionId, state: attempt.result ? 'rejected' : 'queued', at: message.at, ...(attempt.result ? { error: 'Worker finished before acknowledging this message' } : {}) })
    return result
  }
  async sendUserMessage(id: string, message: UserMessage): Promise<MessageReceipt> {
    validateUserMessage(message)
    const attempt = await this.refresh(this.attempt(id))
    const key = `user-message:${id}:${message.id}`
    const previous = this.store.get<UserMessage & { at: string }>(key)
    if (previous && (previous.text !== message.text || previous.questionId !== message.questionId)) throw new Error('Message ID reused with different content')
    if (previous) {
      if (!attempt.result) await enqueueMessage(attempt.directory, attempt.cancelToken, message)
      return (await this.workerInteractions(id)).messages.find(receipt => receipt.id === message.id)!
    }
    if (attempt.result) throw new Error('Worker already finished; no new task was created')
    const started = await json<{ id: string; pid: number; bootId?: string }>(join(attempt.directory, 'started.json'))
    if (started?.id === id && verifiedProcessExit(started.pid, started.bootId)) throw new Error('Worker is interrupted; recover its context before sending a new message')
    const request = await json<WorkerRequest>(join(attempt.directory, 'request.json'))
    if (request?.executor.kind !== 'pi') throw new Error('This one-shot CLI executor does not support live messages; use its native Orca window')
    const phase = await json<{ id: string; phase: string }>(join(attempt.directory, 'phase.json'))
    if (phase?.id !== id || phase.phase !== 'agent') throw new Error('Worker is not accepting messages yet, or is already running acceptance')
    const at = new Date().toISOString()
    this.store.put(key, { ...message, attemptId: id, at }, 'message.intent', { id: message.id, attemptId: id, questionId: message.questionId })
    await enqueueMessage(attempt.directory, attempt.cancelToken, message)
    return { id: message.id, state: 'queued', at, questionId: message.questionId }
  }
  async sendWorker(id: string, subject: string, body: string): Promise<void> {
    const attempt = this.attempt(id)
    // Retry checkpoint is included before startup. Live steering needs a bidirectional adapter.
    if (subject !== 'Continuation checkpoint') throw new Error('Live messaging is not supported by this backend yet')
    this.store.event('checkpoint.recorded', { id: attempt.id, body })
  }
  async stopWorker(id: string): Promise<void> {
    const attempt = await this.refresh(this.attempt(id))
    if (attempt.result) return
    await atomicJson(join(attempt.directory, 'cancel.json'), { id, token: attempt.cancelToken })
    const started = await json<{ id: string; pid: number; bootId?: string; generation?: number }>(join(attempt.directory, 'started.json'))
    const phase = await json<{ id: string; phase: string }>(join(attempt.directory, 'phase.json'))
    const request = await json<WorkerRequest>(join(attempt.directory, 'request.json'))
    if (started?.id === id && (started.generation ?? 0) === (attempt.recovery?.generation ?? attempt.generation ?? 0) && verifiedProcessExit(started.pid, started.bootId)
      && request?.executor.kind === 'pi' && phase?.id === id && ['agent', 'preparing'].includes(phase.phase)) {
      // Controlled Pi tools never spawn child commands. The verified-dead actor cannot mutate files.
      for (const question of (await interactions(attempt.directory)).questions) if (question.state === 'waiting') await atomicJson(join(attempt.directory, 'questions', question.id + '.json'), { ...question, state: 'cancelled' })
      await atomicJson(join(attempt.directory, 'result.json'), { id, outcome: 'cancelled', text: 'Cancelled after verified worker process exit; interrupted session retained.', checks: [], failure: { version: 1, phase: 'cancellation', kind: 'unknown', message: 'Cancelled after verified process exit' }, finishedAt: new Date().toISOString() } satisfies WorkerResult)
      await this.refresh(attempt); return
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if ((await this.refresh(this.attempt(id))).result) return
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error(`Cancellation unconfirmed for ${id}; no replacement was started`)
  }
  async releaseWorker(_id: string): Promise<void> {}
  async failedStartup(runId: string, taskId: string): Promise<undefined> {
    const task = this.store.get<TaskRecord>('task:' + taskId)
    if (task?.attempt) {
      const attempt = await this.refresh(this.attempt(task.attempt))
      if (attempt.runId === runId && !attempt.result) throw new Error('Unsettled worker: reconcile or confirm cancellation before retry')
    }
    return undefined
  }
  private attempt(id: string): AttemptRecord {
    const attempt = this.store.get<AttemptRecord>('attempt:' + id)
    if (!attempt) throw new Error(`Unknown attempt ${id}`)
    return attempt
  }
  async createGate(runId: string, _owner: string, taskId: string, question: string): Promise<string> {
    const id = createHash('sha256').update(taskId + ':' + question).digest('hex').slice(0, 32)
    if (!this.store.get('gate:' + id)) this.store.put('gate:' + id, { id, runId, taskId, question, status: 'pending' } satisfies GateRecord, 'gate.created', { id, taskId, question })
    return id
  }
  async listGates(runId: string, taskId: string): Promise<Record<string, unknown>[]> { return this.store.list<GateRecord>('gate:').filter(gate => gate.runId === runId && gate.taskId === taskId) }
  async resolveGate(id: string, _owner: string, resolution: 'approve' | 'reject'): Promise<void> {
    const gate = this.store.get<GateRecord>('gate:' + id)
    if (!gate) throw new Error('Unknown gate')
    if (gate.resolution && gate.resolution !== resolution) throw new Error('Gate already resolved differently')
    gate.resolution = resolution; gate.status = resolution === 'approve' ? 'approved' : 'rejected'
    this.store.put('gate:' + id, gate, 'gate.resolved', { id, resolution, actor: 'user' })
  }
}
