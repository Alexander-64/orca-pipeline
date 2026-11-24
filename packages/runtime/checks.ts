import { spawn } from 'node:child_process'
import { readFile, open, mkdir, link, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { RunStore } from './store'
import { atomicJson } from './files'
import type { ChecksRequest, ChecksResult, CommandIntent } from './checks-actor'
import type { CheckResult } from './acceptance'
import type { CommandPolicy } from '../core/types'
import { redactValue } from '../core/failover'
import { failureInfo } from '../core/review'
import { currentBootId, processExited } from './process-lifetime'

export type ChecksRecord = { id: string; runId: string; taskId: string; dispatchId: string; directory: string; request: ChecksRequest; nativeResult: Record<string, unknown>; stage: 'intent' | 'launched' | 'finished'; pid?: number; bootId?: string; result?: ChecksResult }
export type ChecksObservation = { state: 'pending' | 'unknown' | 'finished'; checks: CheckResult[]; result?: ChecksResult; command?: string }
const at = () => new Date().toISOString()
async function json<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
function validCheck(check: CheckResult, command: string): boolean {
  return Boolean(check && check.command === command && (check.exitCode === null || Number.isInteger(check.exitCode)) && typeof check.output === 'string' && (check.error === undefined || typeof check.error === 'string'))
}

export class ChecksSupervisor {
  constructor(readonly store: RunStore, readonly project: string) {}
  records(runId?: string) { return this.store.list<ChecksRecord>('native-checks:').filter(record => !runId || record.runId === runId) }
  stopped(runId: string) { return Boolean(this.store.get('native-checks-stop:' + runId)) }
  clearStop(runId: string) { if (this.stopped(runId)) this.store.put('native-checks-stop:' + runId, null) }
  async ensure(input: { runId: string; taskId: string; dispatchId: string; result: Record<string, unknown>; commands: string[]; policy?: CommandPolicy }): Promise<ChecksObservation> {
    input = { ...input, result: redactValue(input.result) as Record<string, unknown> }
    const id = createHash('sha256').update(JSON.stringify([input.runId, input.taskId, input.dispatchId, input.result, input.commands, input.policy])).digest('hex').slice(0, 40)
    let record = this.store.get<ChecksRecord>('native-checks:' + id)
    if (!record && this.records(input.runId).some(record => record.dispatchId === input.dispatchId)) throw new Error('Native report changed after acceptance snapshot; no commands were repeated')
    if (!record) {
      const directory = join(this.project, '.agent-pipeline/runtime/native-checks', id)
      record = { id, runId: input.runId, taskId: input.taskId, dispatchId: input.dispatchId, directory, stage: 'intent', bootId: currentBootId(), nativeResult: input.result,
        request: { version: 1, id, runId: input.runId, taskId: input.taskId, cwd: this.project, token: randomUUID(), commands: input.commands, policy: input.policy } }
      this.store.put('native-checks:' + id, record, 'acceptance.intent', { id, runId: input.runId, taskId: input.taskId, dispatchId: input.dispatchId })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await atomicJson(join(directory, 'request.json'), record.request)
      if (this.stopped(input.runId)) await this.cancel(record)
      else {
        const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './checks-actor.ts' : './checks.mjs', import.meta.url))
        const log = await open(join(directory, 'actor.log'), 'a', 0o600)
        try {
          const child = spawn(process.execPath, [...(entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), entry, join(directory, 'request.json')], { cwd: this.project, detached: true, stdio: ['ignore', log.fd, log.fd] })
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
          child.unref()
          const latest = this.store.get<ChecksRecord>('native-checks:' + id) ?? record
          record = { ...latest, pid: child.pid, stage: latest.result ? 'finished' : 'launched' }
          this.store.put('native-checks:' + id, record, 'acceptance.launched', { id, pid: child.pid })
        } finally { await log.close() }
      }
    }
    return this.observe(record)
  }

  async observe(record: ChecksRecord): Promise<ChecksObservation> {
    const request = record.request
    const result = await json<ChecksResult>(join(record.directory, 'result.json')) ?? record.result
    if (result) {
      if (result.version !== 1 || result.id !== record.id || result.runId !== record.runId || result.taskId !== record.taskId || !['succeeded', 'failed', 'cancelled'].includes(result.outcome) || !Array.isArray(result.checks)) throw new Error('Acceptance result identity mismatch')
      const failure = failureInfo(result.failure)
      if (result.checks.length > request.commands.length || !result.checks.every((check, index) => validCheck(check, request.commands[index]))
        || (result.outcome === 'succeeded' && (result.checks.length !== request.commands.length || result.checks.some(check => check.exitCode !== 0)))
        || (result.outcome === 'failed' && (!result.checks.some(check => check.exitCode !== 0) || failure?.phase !== 'acceptance'))
        || (result.outcome === 'cancelled' && failure?.phase !== 'cancellation')) throw new Error('Acceptance result does not prove the requested command outcomes')
      const latest = this.store.get<ChecksRecord>('native-checks:' + record.id)
      if (!latest?.result) this.store.put('native-checks:' + record.id, { ...record, ...latest, result, stage: 'finished' }, 'acceptance.finished', { id: record.id, taskId: record.taskId, outcome: result.outcome, checks: result.checks })
      return { state: 'finished', result, checks: result.checks }
    }
    const fence = await json<{ id: string; pid?: number; bootId?: string; cancelled?: boolean }>(join(record.directory, 'execution.lock'))
    if (fence && fence.id !== record.id) throw new Error('Acceptance execution fence identity mismatch')
    if (fence?.id === record.id && fence.cancelled) {
      await this.cancelled(record, [], 'Recovered cancellation fence; no acceptance command could start')
      return this.observe(record)
    }
    const checks: CheckResult[] = []
    let active: CommandIntent | undefined
    for (const [index, command] of request.commands.entries()) {
      const receipt = await json<{ id: string; index: number; check: CheckResult }>(join(record.directory, `command-${index}.result.json`))
      if (receipt) {
        if (receipt.id !== record.id || receipt.index !== index || !validCheck(receipt.check, command)) throw new Error('Acceptance command receipt identity mismatch')
        checks.push(receipt.check); continue
      }
      active = await json<CommandIntent>(join(record.directory, `command-${index}.intent.json`))
      if (active && (active.id !== record.id || active.index !== index || active.command !== command)) throw new Error('Acceptance command intent identity mismatch')
      break
    }
    const started = await json<{ id: string; pid: number; bootId?: string }>(join(record.directory, 'started.json'))
    if (started && started.id !== record.id) throw new Error('Acceptance actor identity mismatch')
    const pid = started?.pid ?? fence?.pid ?? record.pid
    const bootId = started?.bootId ?? fence?.bootId ?? record.bootId
    // A final result can be reconstructed only from durable per-command receipts,
    // never from process silence or an absent operation.
    if (processExited(pid, bootId) && (checks.length === request.commands.length || checks.some(check => check.exitCode !== 0))) {
      const cancel = await json<{ id: string; token: string }>(join(record.directory, 'cancel.json'))
      const cancelled = cancel?.id === record.id && cancel.token === record.request.token
      const outcome = cancelled ? 'cancelled' : checks.some(check => check.exitCode !== 0) ? 'failed' : 'succeeded'
      await atomicJson(join(record.directory, 'result.json'), { version: 1, id: record.id, runId: record.runId, taskId: record.taskId, outcome, checks, finishedAt: at(), ...(outcome !== 'succeeded' ? { failure: { version: 1, phase: cancelled ? 'cancellation' : 'acceptance', kind: 'unknown', message: 'Recovered durable command receipts' } } : {}) })
      return this.observe(record)
    }
    return { state: pid && !processExited(pid, bootId) ? 'pending' : 'unknown', checks, command: active?.command }
  }

  async requestStop(runId: string): Promise<void> {
    this.store.put('native-checks-stop:' + runId, { at: at() }, 'acceptance.stop-requested', { runId })
    await Promise.all(this.records(runId).filter(record => !record.result).map(record => atomicJson(join(record.directory, 'cancel.json'), { id: record.id, token: record.request.token })))
  }
  async cancel(record: ChecksRecord): Promise<ChecksResult> {
    await mkdir(record.directory, { recursive: true, mode: 0o700 })
    await atomicJson(join(record.directory, 'cancel.json'), { id: record.id, token: record.request.token })
    let fenced = false
    const fenceFile = join(record.directory, 'cancel-fence-' + randomUUID() + '.json')
    await atomicJson(fenceFile, { id: record.id, cancelled: true })
    try {
      await link(fenceFile, join(record.directory, 'execution.lock')); fenced = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { await unlink(fenceFile) }
    if (fenced) await this.cancelled(record, [], 'Cancelled before acceptance execution; late actors are fenced')
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const observed = await this.observe(record)
      if (observed.result) return observed.result
      const started = await json<{ id: string; pid: number; bootId?: string }>(join(record.directory, 'started.json'))
      const fence = await json<{ id: string; pid?: number; bootId?: string }>(join(record.directory, 'execution.lock'))
      const pid = started?.pid ?? fence?.pid ?? record.pid
      if (processExited(pid, started?.bootId ?? fence?.bootId ?? record.bootId)) {
        const index = observed.checks.length
        const intent = await json<CommandIntent>(join(record.directory, `command-${index}.intent.json`))
        const child = await json<{ id: string; index: number; pid: number; bootId?: string }>(join(record.directory, `command-${index}.child.json`))
        if (!intent || (child?.id === record.id && child.index === index && processExited(child.pid, child.bootId, true))) {
          const checks = [...observed.checks, ...(intent ? [{ command: intent.command, exitCode: null, output: '', error: 'Command process group exited; result is unknown' }] : [])]
          await this.cancelled(record, checks, 'Cancelled after confirmed actor/process-group exit; no command was repeated')
          return (await this.observe(record)).result!
        }
        throw new Error('Acceptance cancellation unconfirmed: interrupted command ownership/result is unknown; no replacement was started')
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Acceptance cancellation unconfirmed; no replacement was started')
  }
  private cancelled(record: ChecksRecord, checks: CheckResult[], message: string) {
    return atomicJson(join(record.directory, 'result.json'), { version: 1, id: record.id, runId: record.runId, taskId: record.taskId, outcome: 'cancelled', checks, failure: { version: 1, phase: 'cancellation', kind: 'unknown', message }, finishedAt: at() } satisfies ChecksResult)
  }
  async reconcile(runId: string): Promise<void> {
    for (const record of this.records(runId)) if ((await this.observe(record)).state === 'unknown') throw new Error('Acceptance is interrupted with an unknown command outcome; inspect or cancel it before retrying')
  }
}
