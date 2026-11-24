import { stepForAgent } from '../core/agent-preferences'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { OrcaClient, defaultRunner, type CommandRunner } from '../../src/cli'
import { StorageMutationJournal } from '../core/mutations'
import type { PipelineRun, Scenario, ScenarioStep } from '../core/types'
import type { ExecutionBackend } from '../core/contracts'
import { checkCommand, validateLocalCommand } from './acceptance'
import type { RuntimeConfig } from './config'
import { RunStore } from './store'
import { taskSpec } from '../core/scenario'
import { waves } from '../core/editor'
import { reviewFromText } from '../core/review'
import { ChecksSupervisor, type ChecksObservation } from './checks'

function record(value: unknown): Record<string, unknown> {
  for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) { try { value = JSON.parse(value) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
type NativeRun = { owner: string; workspace: string; backend: 'orca' }
type NativeTask = { id: string; runId: string; step: ScenarioStep }
type TaskIntent = { requestId: string; id?: string }
type StartIntent = { requestId: string; runId: string; taskId: string; stepId: string; agent: string; startedAt: string; retryOf?: string; dispatchId?: string; rejected?: boolean; terminalHandle?: string }
const dispatchId = (value: unknown): string | undefined => {
  const root = record(value), id = record(root.dispatch).id ?? root.dispatchId ?? root.dispatch_id ?? record(root.worker).id ?? record(root.launch).dispatchId
  return typeof id === 'string' ? id : undefined
}

export class OrcaBackend implements ExecutionBackend {
  readonly client: OrcaClient
  creationRequestId?: string
  private workspace?: string
  readonly checks: ChecksSupervisor

  constructor(readonly store: RunStore, readonly project: string, readonly config: RuntimeConfig, runner?: CommandRunner, private readonly ambientOwner = runner ? undefined : process.env.ORCA_AGENT_SESSION_ID) {
    const journal = new StorageMutationJournal({ get: async key => store.get(key), set: async (key, value) => store.put(key, value) }, 'orca.mutations')
    const transport: CommandRunner = (file, args, cwd, timeout) => {
      if (this.ambientOwner && args[0] === 'orchestration' && args.includes('--from')) {
        const index = args.indexOf('--from')
        if (args[index + 1] !== this.ambientOwner) return Promise.reject(new Error('Cannot impersonate another Orca coordinator from an agent session'))
        args = [...args.slice(0, index), ...args.slice(index + 2)]
      }
      return (runner ?? defaultRunner)(file, args, cwd, timeout)
    }
    this.client = new OrcaClient(transport, config.orca?.executable, journal)
    this.checks = new ChecksSupervisor(store, project)
  }

  async preflightScenario(scenario: Scenario): Promise<void> {
    if (scenario.pullRequest) throw new Error('Console Orca backend does not yet support PR actions')
    const status = record(await this.client.call(['status']))
    const runtime = record(status.runtime)
    const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : []
    if (runtime.state !== 'ready' || !capabilities.includes('orchestration.contract.v1')) throw new Error('Orca runtime lacks the ready orchestration contract')
    if (!capabilities.includes('orchestration.worker-stop-verdict.v1')) throw new Error('Orca runtime cannot confirm worker stop outcomes')
    const selected = this.config.orca?.workspace ?? 'path:' + this.project
    const shown = record((await this.client.call(['worktree', 'show', '--worktree', selected])).worktree)
    const address = record(shown.address)
    if (address.environment !== 'local' || typeof address.worktree !== 'string') throw new Error('Console Orca backend requires an exact local workspace address')
    if (typeof shown.path !== 'string' || await realpath(shown.path) !== await realpath(this.project)) throw new Error('Orca workspace path does not match the selected project')
    this.workspace = address.worktree
    for (const step of scenario.steps) {
      if (step.placement.host !== 'local' || step.placement.worktree !== 'current') throw new Error('Console Orca backend currently supports local/current only')
      for (const agent of [step.agent, ...step.fallback]) {
        const mapped = this.nativeExecutor(step, agent, this.config)
        if ((mapped.step.model || mapped.step.effort) && !capabilities.includes('orchestration.worker-launch-preferences.v1')) throw new Error('Orca runtime does not support model/effort launch preferences')
      }
      for (const command of step.acceptance) validateLocalCommand(command, scenario.commandPolicy)
      await this.client.preflight(step)
    }
  }

  private nativeExecutor(step: ScenarioStep, name: string, config: RuntimeConfig) {
    const executor = config.executors[name]
    if (!executor) throw new Error('Unconfigured Orca executor: ' + name)
    if (!['codex', 'orca'].includes(executor.kind)) throw new Error(`Executor ${name} (${executor.kind}) is local; select the local backend or configure kind: orca with an explicit agent`)
    if (executor.executable || executor.args || executor.provider) throw new Error(`Orca cannot honor local executable, args or provider for ${name}`)
    const agent = executor.kind === 'codex' ? 'codex' : executor.agent
    if (!agent || !/^[\w.-]+$/.test(agent)) throw new Error('Missing native Orca agent for ' + name)
    step = stepForAgent(step, name)
    const model = step.model ?? executor.model
    if (step.effort && !model) throw new Error(`Native effort requires model for ${name}`)
    if (model && !['codex', 'claude', 'cursor', 'antigravity', 'grok', 'muse', 'omp', 'opencode', 'opencode2'].includes(agent)) throw new Error(`Native model launch preference is unsupported for ${agent}; use its own CLI configuration`)
    if (step.effort && ['opencode', 'opencode2'].includes(agent)) throw new Error('Native OpenCode does not support effort')
    return { agent, step: { ...step, model } }
  }

  canStart(run: PipelineRun, _step: ScenarioStep, agent: string): boolean {
    const active = Object.values(run.tasks).filter(task => task.unconfirmedStart || task.attempts.at(-1)?.status === 'running')
    if (!run.scenario.commandPolicy?.readOnly && active.length) return false
    const executors = (this.store.get<RuntimeConfig>('execution:' + run.runId) ?? this.config).executors
    const provider = (name: string) => executors[name]?.kind === 'codex' ? 'codex' : executors[name]?.agent ?? name
    const limit = run.scenario.providerLimits?.[provider(agent)]
    return limit === undefined || active.filter(task => provider(task.agent) === provider(agent)).length < limit
  }

  async createRun(objective: string, _owner: string): Promise<string> {
    if (!this.workspace) throw new Error('Run preflight first')
    const key = 'orca-owner:' + (this.creationRequestId ?? randomUUID())
    const prior = this.store.get<{ owner?: string; stage: string }>(key)
    if (prior && !prior.owner) throw new Error('Coordinator terminal creation is unconfirmed; inspect Orca before retry')
    let owner = this.ambientOwner ?? prior?.owner
    if (!owner) {
      this.store.put(key, { stage: 'intent' })
      const result = await this.client.call(['terminal', 'create', '--worktree', this.workspace, '--title', 'Pipeline console coordinator'])
      const terminal = record(result.terminal)
      const handle = result.terminalHandle ?? result.terminalId ?? terminal.handle ?? terminal.id
      if (typeof handle !== 'string') throw new Error('Orca coordinator terminal receipt has no handle; no retry was sent')
      owner = handle; this.store.put(key, { stage: 'created', owner })
    }
    const runId = await this.client.createRun(objective, owner)
    this.store.put('native-run:' + runId, { owner, workspace: this.workspace, backend: 'orca' } satisfies NativeRun)
    this.store.put('execution:' + runId, this.config)
    return runId
  }
  private native(runId: string): NativeRun {
    const native = this.store.get<NativeRun>('native-run:' + runId)
    if (!native?.owner || native.backend !== 'orca') throw new Error('Missing Orca run ownership receipt')
    return native
  }
  async reconcile(run: PipelineRun): Promise<void> {
    await this.checks.reconcile(run.runId)
    for (const task of Object.values(run.tasks)) task.unconfirmedChecks = undefined
    if (this.checks.stopped(run.runId)) { run.status = 'paused'; run.error = 'Acceptance cancellation was requested; repeat stop to confirm all workers, or explicitly resume' }
    await this.client.recoverPending()
    for (const step of waves(run.scenario.steps).flat()) {
      if (!run.tasks[step.id]) {
        const id = await this.createTask(run.runId, run.coordinatorHandle, step, taskSpec(step, undefined, run.runId, run.scenario.version === 2), run.scenario.version === 2 ? [] : step.needs.map(id => run.tasks[id].taskId))
        run.tasks[step.id] = { stepId: step.id, taskId: id, status: 'pending', agent: step.agent, attempts: [] }
      }
    }
    const intents = this.store.list<StartIntent>('orca-start-intent:').filter(intent => intent.runId === run.runId).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (const intent of intents) {
      const task = run.tasks[intent.stepId]
      if (task?.history?.some(revision => revision.taskId === intent.taskId)) continue
      if (task?.taskId !== intent.taskId && task?.attempts.some(attempt => attempt.status !== 'running' && attempt.dispatchId === intent.dispatchId)) continue
      if (!task || task.taskId !== intent.taskId) throw new Error('Native start intent does not match the pipeline task')
      if (intent.rejected && !intent.dispatchId) {
        if (task.unconfirmedStart) { task.unconfirmedStart = undefined; task.retryRequested = undefined; task.status = 'failed'; task.error = 'Native startup was rejected before dispatch; resolve the existing window and retry' }
        continue
      }
      let id = intent.dispatchId
      if (!id) {
        const receipt = await this.client.mutationReceipt(intent.requestId)
        if (receipt?.status === 'completed') id = dispatchId(receipt.result)
      }
      if (!id) throw new Error(`Native start ${intent.requestId} is unconfirmed. Inspect the existing Orca window; no replacement was started.`)
      this.store.put('orca-dispatch:' + id, { ...intent, dispatchId: id })
      const successor = intents.some(next => next.retryOf === id)
      const existing = task.attempts.find(attempt => attempt.dispatchId === id)
      if (!task.unconfirmedStart && ((existing && (existing.status !== 'running' || !successor)) || (task.startup?.dispatchId === id && !successor))) continue
      const shown = await this.client.call(['orchestration', 'worker-show', '--dispatch', id, '--full'])
      const dispatch = record(shown.dispatch), worker = record(shown.worker)
      if (dispatch.id !== id || (dispatch.taskId ?? dispatch.task_id) !== intent.taskId || dispatch.runId !== run.runId) throw new Error('Native recovery receipt identity mismatch')
      const inputAccepted = Array.isArray(worker.effects) && worker.effects.some(effect => record(effect).kind === 'dispatch_input' && record(effect).state === 'accepted')
      if (inputAccepted) {
        if (successor && !['failed', 'abandoned', 'stopped', 'succeeded'].includes(String(worker.state))) throw new Error('Previous native attempt is still active; replacement ownership is ambiguous')
        const recovered = { dispatchId: id, agent: intent.agent, status: successor ? worker.state === 'succeeded' ? 'done' as const : 'failed' as const : 'running' as const, startedAt: intent.startedAt,
          ...(successor ? { finishedAt: typeof dispatch.completedAt === 'string' ? dispatch.completedAt : undefined, output: await this.client.workerOutput(id), reason: 'reconciled-native-' + String(worker.state) } : {}) }
        if (existing) Object.assign(existing, recovered)
        else task.attempts.push(recovered)
        if (!successor) { task.unconfirmedStart = undefined; task.retryRequested = undefined; task.error = undefined; task.waitReason = undefined; task.activityObservedAt = undefined }
        task.agent = intent.agent; task.status = 'running'; task.startup = undefined
      } else if (['failed', 'abandoned', 'stopped'].includes(String(worker.state))) {
        if (successor) continue // Startup failure did not consume an attempt and has an explicit retry.
        task.unconfirmedStart = undefined
        task.startup = { dispatchId: id, ...(typeof worker.agentTerminalHandle === 'string' ? { terminalHandle: worker.agentTerminalHandle } : {}), stage: typeof worker.stage === 'string' ? worker.stage : undefined }
        task.status = 'failed'; task.error = 'Native worker stopped before task input was accepted; resolve startup before retrying.'
        run.status = 'failed'
      } else throw new Error('Native task input is not confirmed; no attempt was invented or restarted')
    }
    this.store.put('run:' + run.id, run, 'run.reconciled', { id: run.id, backend: 'orca' })
  }
  async bindRun(runId: string, _owner: string): Promise<void> {
    await this.checks.reconcile(runId)
    this.checks.clearStop(runId)
    await this.client.bindRun(runId, this.native(runId).owner)
  }
  async createTask(runId: string, _owner: string, step: ScenarioStep, spec: string, dependencies: string[], revision: number | string = 0): Promise<string> {
    const key = 'orca-task-intent:' + runId + ':' + step.id + (revision ? ':revision:' + revision : '')
    const intent = this.store.get<TaskIntent>(key) ?? { requestId: randomUUID() }
    this.store.put(key, intent)
    const id = intent.id ?? await this.client.createTask(runId, this.native(runId).owner, step, spec, dependencies, intent.requestId)
    this.store.put(key, { ...intent, id })
    this.store.put('orca-task:' + id, { id, runId, step } satisfies NativeTask); return id
  }
  reviseTask(run: PipelineRun, step: ScenarioStep, revision: number, spec: string, dependencies: string[]): Promise<string> {
    return this.createTask(run.runId, run.coordinatorHandle, step, spec, dependencies, revision)
  }
  async prepareRetry(run: PipelineRun, step: ScenarioStep, task: PipelineRun['tasks'][string]): Promise<string | undefined> {
    const previous = task.attempts.at(-1)
    if (!previous || !['acceptance', 'validation', 'review'].includes(previous.failure?.phase ?? '')) return undefined
    const receipt = this.store.get<StartIntent>('orca-dispatch:' + previous.dispatchId)
    if (receipt?.taskId !== task.taskId) return undefined
    // A successful native worker report remains true even if independent runtime
    // validation rejects its result. Re-review uses a new Task, never retry-of a
    // successful Dispatch or a fabricated failed worker report.
    return this.createTask(run.runId, run.coordinatorHandle, step, taskSpec(step, undefined, run.runId, run.scenario.version === 2), run.scenario.version === 2 ? [] : step.needs.map(id => run.tasks[id].taskId), 'after-' + previous.dispatchId)
  }
  async listTasks(runId: string): Promise<Record<string, unknown>[]> {
    const tasks = await this.client.listTasks(runId)
    const run = this.store.list<PipelineRun>('run:').find(run => run.runId === runId)
    for (const task of tasks) {
      const local = this.store.get<NativeTask>('orca-task:' + task.id)
      if (!local || !run || run.tasks[local.step.id]?.taskId !== task.id) continue
      if (['failed', 'abandoned', 'cancelled', 'canceled'].includes(String(task.status))) {
        const result = record(task.result)
        // A worker's report may quote source code, logs and prompts. Those are
        // not a provider failure signal (even when they contain 429/timeout).
        task.result = { ...result, failure: { version: 1, phase: 'executor', kind: 'unknown', message: typeof result.body === 'string' ? result.body.slice(-4000) : 'Native worker did not succeed' } }
        if (run && local?.step.role === 'evidence' && result.provenance === 'worker_report' && typeof result.body === 'string') {
          try {
            const review = reviewFromText(result.body)
            const observation = await this.acceptance(task, local, run, result)
            if (!observation.result) { this.pendingChecks(task, result, observation); continue }
            const { checks } = observation
            task.result = { ...result, review, checks, failure: { version: 1, phase: checks.some(check => check.exitCode !== 0) ? 'acceptance' : 'review', kind: 'unknown', message: 'Native review verdict: ' + review.verdict } }
            if (observation.result.outcome === 'cancelled') task.result = { ...result, review, checks, failure: observation.result.failure }
          } catch (error) {
            task.result = { ...result, failure: { version: 1, phase: 'validation', kind: 'unknown', message: error instanceof Error ? error.message : String(error) } }
          }
        }
        continue
      }
      if (!['completed', 'succeeded', 'done'].includes(String(task.status))) continue
      const result = record(task.result)
      if (result.provenance !== 'worker_report' || result.outcome !== 'succeeded') {
        task.status = 'failed'; task.result = { ...result, failure: { version: 1, phase: 'validation', kind: 'unknown', message: 'Native Task has no successful worker report' }, validationError: 'Native Task has no successful worker report' }
        this.store.put('orca-validation:' + task.id, 'Native Task has no successful worker report')
        continue
      }
      const observation = await this.acceptance(task, local, run, result)
      if (!observation.result) { this.pendingChecks(task, result, observation); continue }
      const { checks } = observation
      task.result = { ...result, checks }
      if (observation.result.outcome !== 'succeeded') {
        task.result = { ...result, checks, failure: observation.result.failure }
        task.status = 'failed'; this.store.put('orca-validation:' + task.id, 'Runtime acceptance failed: ' + JSON.stringify(checks))
      }
    }
    return tasks
  }
  private pendingChecks(task: Record<string, unknown>, result: Record<string, unknown>, observation: ChecksObservation) {
    task.status = 'running'; task.result = { ...result, checks: observation.checks, runtimeChecksState: observation.state, runtimeChecksCommand: observation.command }
  }
  private async acceptance(task: Record<string, unknown>, local: NativeTask, run: PipelineRun, result: Record<string, unknown>): Promise<ChecksObservation> {
    const key = 'orca-checks:' + String(task.id) + ':' + createHash('sha256').update(JSON.stringify(result)).digest('hex')
    const legacyKey = 'orca-checks:' + String(task.id) + ':' + createHash('sha256').update(JSON.stringify(task.result ?? {})).digest('hex')
    const checks = this.store.get<Awaited<ReturnType<typeof checkCommand>>[]>(key) ?? this.store.get<Awaited<ReturnType<typeof checkCommand>>[]>(legacyKey)
    if (checks) return { state: 'finished', checks, result: { version: 1, id: key, runId: run.runId, taskId: String(task.id), outcome: checks.some(check => check.exitCode !== 0) ? 'failed' : 'succeeded', checks, finishedAt: '', ...(checks.some(check => check.exitCode !== 0) ? { failure: { version: 1, phase: 'acceptance', kind: 'unknown', message: 'Cached acceptance failed' } } : {}) } }
    const dispatchId = run.tasks[local.step.id]?.attempts.at(-1)?.dispatchId
    if (!dispatchId) throw new Error('No confirmed native dispatch for acceptance; no command was started')
    try { return await this.checks.ensure({ runId: run.runId, taskId: String(task.id), dispatchId, result, commands: local.step.acceptance, policy: run.scenario.commandPolicy }) }
    catch (error) { return { state: 'unknown', checks: [], command: error instanceof Error ? error.message : String(error) } }
  }
  async skipTask(runId: string, _owner: string, taskId: string, reason: string): Promise<void> {
    const key = 'orca-skip-intent:' + taskId + ':' + createHash('sha256').update(reason).digest('hex')
    const intent = this.store.get<TaskIntent>(key) ?? { requestId: randomUUID() }
    this.store.put(key, intent)
    await this.client.skipTask(runId, this.native(runId).owner, taskId, reason, intent.requestId)
  }
  prepareCheckpoint(run: PipelineRun, step: ScenarioStep, taskId: string, body: string): Promise<void> { return this.client.prepareCheckpoint(run, step, taskId, body) }
  async startWorker(run: PipelineRun, step: ScenarioStep, taskId: string, agent: string, retryOf?: string, reuseTerminal?: string): Promise<string> {
    const native = this.native(run.runId)
    const config = this.store.get<RuntimeConfig>('execution:' + run.runId) ?? this.config
    const mapped = this.nativeExecutor(step, agent, config)
    const key = 'orca-start-intent:' + createHash('sha256').update(JSON.stringify([run.runId, taskId, agent, retryOf ?? null])).digest('hex')
    const previous = this.store.get<StartIntent>(key)
    if (previous && !previous.dispatchId && !previous.rejected) {
      const receipt = await this.client.mutationReceipt(previous.requestId)
      // This is a positive server-side precondition rejection, not inference from an absent receipt.
      if (receipt?.status === 'failed' && receipt.error?.startsWith(`Task ${taskId} is blocked; only a ready Task can start.`)) previous.rejected = true
    }
    if (previous && !previous.rejected) throw Object.assign(new Error('Native start already has a durable intent. Reconcile before retrying; no new worker was started.'), { startOutcome: 'unknown' })
    const previousReceipt = previous ? await this.client.mutationReceipt(previous.requestId) : undefined
    const intent: StartIntent = { requestId: previousReceipt?.status === 'failed' ? randomUUID() : previous?.requestId ?? randomUUID(), runId: run.runId, taskId, stepId: step.id, agent, retryOf, startedAt: new Date().toISOString() }
    this.store.put(key, intent, 'attempt.intent', { taskId, agent, requestId: intent.requestId })
    let id: string
    try {
      id = await this.client.startWorker({ ...run, coordinatorHandle: native.owner, workspaceSelector: native.workspace, visibleWorkers: config.orca?.visibleWorkers !== false }, mapped.step, taskId, mapped.agent, retryOf, reuseTerminal, intent.requestId)
      this.store.put(key, { ...intent, dispatchId: id })
      this.store.put('orca-dispatch:' + id, { ...intent, dispatchId: id })
      this.store.put('orca-validation:' + taskId, null)
      return id
    } catch (error) {
      const details = record(record(error).details)
      const failed = dispatchId(record(details.result)) ?? dispatchId(details)
      if (failed) this.store.put(key, { ...intent, dispatchId: failed })
      if (record(error).startOutcome === 'rejected' && !failed) this.store.put(key, { ...intent, rejected: true, ...(typeof record(error).launchedTerminal === 'string' ? { terminalHandle: record(error).launchedTerminal as string } : {}) })
      else if (!Object.keys(details).length) Object.assign(error instanceof Error ? error : {}, { startOutcome: 'unknown' })
      throw error
    }
  }
  async workerOutput(id: string): Promise<string> {
    const output = await this.client.workerOutput(id)
    const dispatch = this.store.get<{ taskId: string }>('orca-dispatch:' + id)
    const error = dispatch ? this.store.get<string>('orca-validation:' + dispatch.taskId) : undefined
    return error ? output + '\n\nRuntime validation: ' + error : output
  }
  async workerFailure(id: string) {
    const record = this.checks.records().find(record => record.dispatchId === id)
    if (!record) return undefined
    const observed = await this.checks.observe(record)
    return { settled: observed.state === 'finished', failure: observed.result?.failure }
  }
  workerActivityDone(id: string): Promise<boolean> { return this.client.workerActivityDone(id) }
  async workerObservation(id: string) {
    const record = this.checks.records().find(record => record.dispatchId === id)
    if (record) {
      const observed = await this.checks.observe(record)
      if (observed.state !== 'finished') return { activity: observed.state === 'unknown' ? 'acceptance-interrupted' : 'acceptance', waitReason: observed.state === 'unknown' ? 'Acceptance outcome is unknown; reconcile or confirm cancellation before retry' : observed.command ?? 'Waiting for acceptance process' }
    }
    return this.client.workerObservation(id)
  }
  requestStop(runId: string) { return this.checks.requestStop(runId) }
  async stopWorker(id: string): Promise<void> {
    const records = this.checks.records().filter(record => record.dispatchId === id)
    if (records.length) { for (const record of records) await this.checks.cancel(record); return }
    await this.client.stopWorker(id)
  }
  async settledResult(id: string): Promise<Record<string, unknown> | undefined> {
    const record = this.checks.records().find(record => record.dispatchId === id)
    if (!record) return undefined
    const observed = await this.checks.observe(record)
    return observed.result ? { ...record.nativeResult, checks: observed.checks, failure: observed.result.failure, checksOutcome: observed.result.outcome } : undefined
  }
  releaseWorker(id: string): Promise<void> { return this.client.releaseWorker(id) }
  openWorker(id: string): Promise<void> { return this.client.openWorker(id) }
  async sendWorker(id: string, subject: string, body: string): Promise<void> {
    const dispatch = this.store.get<{ runId: string }>('orca-dispatch:' + id)
    if (!dispatch) throw new Error('Unknown Orca dispatch owner')
    await this.client.sendWorker(id, subject, body, this.native(dispatch.runId).owner)
  }
  failedStartup(runId: string, taskId: string) { return this.client.failedStartup(runId, taskId) }
  async createGate(runId: string, _owner: string, taskId: string, question: string): Promise<string> {
    const key = 'orca-gate-intent:' + createHash('sha256').update(JSON.stringify([runId, taskId, question])).digest('hex')
    const intent = this.store.get<TaskIntent>(key) ?? { requestId: randomUUID() }
    this.store.put(key, intent)
    const id = intent.id ?? await this.client.createGate(runId, this.native(runId).owner, taskId, question, intent.requestId)
    this.store.put(key, { ...intent, id })
    this.store.put('orca-gate:' + id, { runId }); return id
  }
  listGates(runId: string, taskId: string) { return this.client.listGates(runId, taskId) }
  async resolveGate(id: string, _owner: string, resolution: 'approve' | 'reject'): Promise<void> {
    const gate = this.store.get<{ runId: string }>('orca-gate:' + id)
    if (!gate) throw new Error('Unknown Orca gate')
    await this.client.resolveGate(id, this.native(gate.runId).owner, resolution)
  }
}
