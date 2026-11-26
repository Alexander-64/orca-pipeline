import { stepForAgent } from './agent-preferences'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { workspaceSelector, type ExecutionBackend, type BeadsPort, type PrPort } from './contracts'
import type { AttemptArtifactStore } from './artifacts'
import { hasCapacity } from './capacity'
import { classifyFailure, handoffFor, liveQuotaMessage, nextAgent, redactSecrets } from './failover'
import { chooseAvailableAgent, type UsageReader, type UsageWindow } from './quota'
import { taskSpec } from './scenario'
import { waves } from './editor'
import type { Attempt, PipelineRun, PipelineTask, Scenario, ScenarioStep, Workspace, ReviewResult } from './types'
import { readiness, resultFromText, validateResult } from './results'
import { failureInfo, reviewFromText, validateReview } from './review'

type Deps = {
  client: ExecutionBackend
  beadsFor?: (workspacePath: string) => BeadsPort
  usage?: UsageReader
  artifacts?: AttemptArtifactStore
  pr?: PrPort
  save: (run: PipelineRun) => Promise<void>
  notify: (run: PipelineRun) => void
  log: (message: string) => void
}

const ACTIVE = new Set(['running', 'retrying'])
const DONE = new Set(['completed', 'succeeded', 'success', 'done'])
const FAILED = new Set(['failed', 'stopped', 'cancelled', 'canceled'])

function now(): string {
  return new Date().toISOString()
}

function statusOf(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function workerResult(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return workerResult(parsed)
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function applyEvidence(attempt: Attempt, result: Record<string, unknown>): void {
  if (typeof result.reportPath === 'string') attempt.reportPath = result.reportPath
  const files = result.filesModified ?? result.files_modified
  if (Array.isArray(files)) attempt.filesModified = files.filter((file): file is string => typeof file === 'string')
  if (Array.isArray(result.checks)) attempt.checks = result.checks.filter((check): check is { command: string; exitCode: number | null } => Boolean(check && typeof check === 'object' && typeof check.command === 'string' && (check.exitCode === null || typeof check.exitCode === 'number'))).map(check => ({ command: check.command, exitCode: check.exitCode }))
  if (Array.isArray(result.uncertainFiles)) attempt.uncertainFiles = result.uncertainFiles.filter((file): file is string => typeof file === 'string')
  const failure = failureInfo(result.failure); if (failure) attempt.failure = failure
  if (result.review !== undefined) { try { attempt.review = validateReview(result.review) } catch { /* Invalid results cannot supply a verdict. */ } }
}

function failureMessage(attempt: Attempt, subject?: unknown): string {
  const failedCheck = attempt.checks?.find(check => check.exitCode !== null && check.exitCode !== 0)
  if (failedCheck) return redactSecrets(`Check failed (exit ${failedCheck.exitCode}): ${failedCheck.command}`).slice(0, 500)
  for (const detail of [attempt.failure?.message, subject, attempt.output]) {
    if (typeof detail === 'string' && detail.trim()) {
      const text = redactSecrets(detail.trim())
      return text.length > 1500 ? `${text.slice(0, 1500)}…` : text
    }
  }
  return 'Worker ended without a failure report.'
}

function reviewResult(result: Record<string, unknown>, output: string): ReviewResult | undefined {
  if (result.review !== undefined) return validateReview(result.review)
  const text = typeof result.body === 'string' ? result.body : output
  if (/^\s*(?:\{|```)/.test(text) && text.includes('"pipelineReview"')) return reviewFromText(text)
  return undefined
}

function agentRouting(step: ScenarioStep) {
  const { agent, fallback, model, effort, agentPreferences, routingReason, ...instructions } = step
  return { routing: { agent, fallback, model, effort, agentPreferences, routingReason }, instructions }
}

export function assertRunVersions(runs: PipelineRun[]): void {
  for (const run of runs) {
    if (![undefined, 1, 2, 3, 4].includes(run.stateVersion)) throw new Error(`Unsupported saved pipeline state version ${run.stateVersion} for ${run.id}; records were not changed`)
    if (![undefined, 1, 2].includes(run.scenario?.version)) throw new Error(`Unsupported saved scenario version ${run.scenario?.version} for ${run.id}; records were not changed`)
  }
}

export class Coordinator {
  private readonly runs = new Map<string, PipelineRun>()
  private readonly ticking = new Set<string>()
  private readonly controls = new Set<string>()
  private readonly ticks = new Map<string, Promise<void>>()
  private readonly deferredStarts = new Map<string, Set<symbol>>()

  deferStarts(id: string): () => void {
    const token = Symbol('pending control')
    const tokens = this.deferredStarts.get(id) ?? new Set<symbol>()
    tokens.add(token); this.deferredStarts.set(id, tokens)
    return () => { tokens.delete(token); if (!tokens.size) this.deferredStarts.delete(id) }
  }

  private schedulingAllowed(run: PipelineRun): boolean {
    return run.status === 'running' && !this.controls.has(run.id) && !this.deferredStarts.has(run.id)
  }

  private async control(id: string, operation: () => Promise<void>): Promise<void> {
    if (this.controls.has(id)) throw new Error('Дождитесь завершения текущей операции pipeline')
    this.controls.add(id)
    try {
      await this.ticks.get(id)
      await operation()
    } finally { this.controls.delete(id) }
    await this.tick(id)
  }


  constructor(private readonly deps: Deps) {}

  list(): PipelineRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): PipelineRun {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Запуск ${id} не найден`)
    return run
  }

  restore(runs: PipelineRun[], options: { autoResume?: boolean } = {}): void {
    assertRunVersions(runs) // Validate the complete batch before any binding or tick.
    for (const run of runs) {
      for (const task of Object.values(run.tasks)) {
        const attempt = task.attempts.at(-1)
        if (task.status === 'failed' && task.error === 'Исполнитель завершился: unknown' && attempt) {
          // Older snapshots retained the report but used only the failure category in the UI.
          task.error = failureMessage(attempt)
        }
      }
      this.runs.set(run.id, run)
      if (options.autoResume !== false && run.status === 'running') void this.deps.client.bindRun(run.runId, run.coordinatorHandle)
        .then(() => this.tick(run.id))
        .catch((error: unknown) => this.recordError(run, error))
    }
  }

  async start(workspace: Workspace, coordinatorHandle: string, scenario: Scenario, options: { visibleWorkers?: boolean; sourceWorkspaceId?: string; reviewBase?: string } = {}): Promise<PipelineRun> {
    if (scenario.version === 2 && scenario.steps.some(step => step.placement.host !== 'local' || step.placement.worktree !== 'current')) throw new Error('Scenario v2 currently requires local/current placement for shared result artifacts')
    await this.deps.client.preflightScenario?.(scenario)
    const createdAt = now()
    const runId = await this.deps.client.createRun(scenario.objective, coordinatorHandle)
    const run: PipelineRun = {
      stateVersion: 4,
      id: randomUUID(),
      runId,
      coordinatorHandle,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceSelector: workspaceSelector(workspace),
      scenario,
      ...options,
      status: 'running',
      tasks: {},
      createdAt,
      updatedAt: createdAt
    }
    this.controls.add(run.id)
    this.runs.set(run.id, run)
    try {
      await this.deps.save(run)
      const remaining = new Map(scenario.steps.map((step) => [step.id, step]))
      while (remaining.size) {
        const step = [...remaining.values()].find((candidate) => candidate.needs.every((id) => run.tasks[id]?.taskId))
        if (!step) throw new Error('Не удалось упорядочить шаги сценария')
        const dependencies = scenario.version === 2 ? [] : step.needs.map((id) => run.tasks[id].taskId)
        const taskId = await this.deps.client.createTask(runId, coordinatorHandle, step, taskSpec(step, undefined, runId, scenario.version === 2 || step.placement.host === 'local' && step.placement.worktree === 'current', step.placement.host === 'local' && step.placement.worktree === 'current' ? workspace.path : undefined), dependencies)
        const task: PipelineTask = { stepId: step.id, taskId, status: 'pending', agent: step.agent, attempts: [] }
        run.tasks[step.id] = task
        run.updatedAt = now()
        await this.deps.save(run)
        remaining.delete(step.id)
      }
      await this.createBeads(run)
    } catch (error) {
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      run.updatedAt = now()
      await this.deps.save(run)
      this.deps.notify(run)
      throw error
    } finally { this.controls.delete(run.id) }
    this.deps.notify(run)
    await this.tick(run.id)
    return run
  }

  private async createBeads(run: PipelineRun): Promise<void> {
    if (!this.deps.beadsFor) return
    const beads = this.deps.beadsFor(run.workspacePath)
    const remaining = new Set(run.scenario.steps.map((step) => step.id))
    while (remaining.size) {
      const step = run.scenario.steps.find((candidate) => remaining.has(candidate.id) && candidate.needs.every((id) => run.tasks[id].beadId))
      if (!step) break
      const task = run.tasks[step.id]
      const dependencies = step.needs.map((id) => run.tasks[id].beadId!)
      try {
        task.beadId = await beads.create(run.runId, step, dependencies)
        run.updatedAt = now()
        await this.deps.save(run)
      } catch (error) {
        this.deps.log(`Beads: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
      remaining.delete(step.id)
    }
  }

  async tick(id: string): Promise<void> {
    if (this.controls.has(id)) return
    const current = this.ticks.get(id)
    if (current) return current
    const tick = this.tickOnce(id)
    this.ticks.set(id, tick)
    try { await tick } finally { if (this.ticks.get(id) === tick) this.ticks.delete(id) }
  }

  // A failed sibling must not hide questions from an already running worker.
  async observeActiveWorkers(id: string): Promise<void> {
    const run = this.get(id)
    if (!this.deps.client.workerObservation) return
    let changed = false
    for (const task of Object.values(run.tasks)) {
      const attempt = task.attempts.at(-1)
      if (attempt?.status !== 'running') continue
      const observed = await this.deps.client.workerObservation(attempt.dispatchId).catch(() => undefined)
      if (!observed) continue
      task.activity = observed.activity; task.waitReason = observed.waitReason
      if (observed.questions) task.questions = observed.questions
      if (observed.interaction) task.interaction = observed.interaction
      task.activityObservedAt = now(); changed = true
    }
    if (changed) { await this.deps.save(run); this.deps.notify(run) }
  }

  private async tickOnce(id: string): Promise<void> {
    if (this.ticking.has(id)) return
    const run = this.get(id)
    if (run.status === 'failed') {
      await this.observeActiveWorkers(id)
      return
    }
    if (run.status === 'done' || run.status === 'cancelled') return
    this.ticking.add(id)
    try {
      const rawTasks = await this.deps.client.listTasks(run.runId)
      const rawById = new Map(rawTasks.map((task) => [String(task.id), task]))
      let changed = false
      for (const step of run.scenario.steps) {
        const task = run.tasks[step.id]
        if (!task) continue
        if (task.unconfirmedStart || task.revisionPending) continue
        const rawResult = workerResult(rawById.get(task.taskId)?.result)
        if (rawResult.runtimeChecksState === 'unknown') {
          task.unconfirmedChecks = true; task.activity = 'acceptance-interrupted'
          task.waitReason = 'Acceptance outcome is unknown; reconcile or confirm cancellation before retry'
          task.error = typeof rawResult.runtimeChecksCommand === 'string' ? rawResult.runtimeChecksCommand : task.waitReason
          run.status = 'paused'; changed = true; continue
        }
        if (task.unconfirmedChecks) { task.unconfirmedChecks = undefined; task.error = undefined; changed = true }
        if (task.repairPending) {
          if (this.schedulingAllowed(run)) { await this.handleEvidenceVerdict(run, step, task, task.attempts.at(-1)?.output ?? '', task.attempts.at(-1)?.review); changed = true; await this.captureTaskState(run, task) }
          continue
        }
        if (run.scenario.version === 2 && ['done', 'failed', 'skipped', 'superseded'].includes(task.status)) continue
        const rawStatus = task.retryRequested ? run.scenario.version === 2 ? 'pending' : 'ready' : statusOf(rawById.get(task.taskId)?.status)
        if (DONE.has(rawStatus)) {
          if (task.status !== 'done') {
            const result = workerResult(rawById.get(task.taskId)?.result)
            if (step.role === 'evidence') {
              try {
                const review = reviewResult(result, await this.deps.client.workerOutput(task.attempts.at(-1)!.dispatchId))
                if (!review && String(rawById.get(task.taskId)?.spec ?? '').includes('"pipelineReview"')) throw new Error('Reviewer did not return a versioned verdict')
                if (review) result.review = review
                if (review && review.verdict !== 'SHIP') {
                  result.failure = { version: 1, phase: 'review', kind: 'unknown', message: 'Evidence verdict: ' + review.verdict }
                  await this.handleFailed(run, step, task, result); changed = true; await this.captureTaskState(run, task); continue
                }
              } catch (error) {
                result.failure = { version: 1, phase: 'validation', kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
                await this.handleFailed(run, step, task, result); changed = true; await this.captureTaskState(run, task); continue
              }
            }
            if (step.outputSchema) {
              try {
                if (result.data !== undefined && result.dataVersion !== 1) throw new Error('Unsupported structured result version')
                task.data = result.data !== undefined ? validateResult(step.outputSchema, result.data)
                  : resultFromText(step.outputSchema, typeof result.body === 'string' ? result.body : await this.deps.client.workerOutput(task.attempts.at(-1)!.dispatchId))
                if (task.attempts.at(-1)) task.attempts.at(-1)!.data = task.data
              } catch (error) {
                result.failure = { version: 1, phase: 'validation', kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
                await this.finishAttempt(run, task, 'failed', result)
                task.status = 'failed'; task.error = 'Structured result: ' + (error instanceof Error ? error.message : String(error))
                task.data = undefined; changed = true; await this.syncBead(run, task); await this.captureTaskState(run, task); continue
              }
            }
            await this.finishAttempt(run, task, 'done', result)
            task.status = 'done'
            task.error = undefined
            changed = true
            await this.syncBead(run, task)
            await this.captureTaskState(run, task)
            if (step.role === 'repair') await this.retryEvidenceAfterRepair(run, step)
          }
          continue
        }
        if (FAILED.has(rawStatus)) {
          if ((task.status !== 'failed' && task.status !== 'superseded') || ACTIVE.has(task.status)) {
            await this.handleFailed(run, step, task, workerResult(rawById.get(task.taskId)?.result))
            await this.captureTaskState(run, task)
            changed = true
          }
          continue
        }
        if (rawStatus === 'blocked' && ACTIVE.has(task.status) && task.attempts.at(-1) && this.deps.client.workerObservation) {
          const observed = await this.deps.client.workerObservation(task.attempts.at(-1)!.dispatchId)
          if (['abandoned', 'stopped', 'failed'].includes(observed.workerState ?? '')) {
            await this.finishAttempt(run, task, 'failed')
            task.attempts.at(-1)!.reason = `worker-${observed.workerState}`
            task.status = 'failed'
            task.error = 'Назначение завершено без результата; выберите исполнителя для повтора.'
            changed = true
            continue
          }
        }
        let ready = rawStatus === 'ready'
        if (run.scenario.version === 2 && !ACTIVE.has(task.status) && !['done', 'failed', 'superseded'].includes(task.status)) {
          const decision = readiness(step, run.tasks)
          ready = decision.state === 'ready' && ['ready', 'pending', 'blocked'].includes(rawStatus)
          if (decision.state === 'skip' && this.schedulingAllowed(run)) {
            await this.deps.client.skipTask?.(run.runId, run.coordinatorHandle, task.taskId, decision.reason!)
            task.status = 'skipped'; task.skipReason = decision.reason; task.data = undefined
            changed = true; await this.syncBead(run, task); await this.captureTaskState(run, task); continue
          }
        }
        if (ready && this.schedulingAllowed(run) && hasCapacity(run.scenario, run.tasks, step) && !ACTIVE.has(task.status) && task.status !== 'done' && task.status !== 'failed') {
          task.status = 'ready'
          if (step.approval && !await this.approvalGranted(run, step, task)) {
            await this.captureTaskState(run, task)
            changed = true
            continue
          }
          await this.tryStartAttempt(run, step, task, task.retrySameAgent === true)
          changed = true
          continue
        }
        if (rawStatus === 'dispatched' || rawStatus === 'running') {
          const attempt = task.attempts.at(-1)
          if (attempt && this.deps.client.workerObservation && (!task.activityObservedAt || Date.now() - Date.parse(task.activityObservedAt) >= (this.deps.client.observationIntervalMs?.(attempt.dispatchId) ?? 10000))) {
            const observed = await this.deps.client.workerObservation(attempt.dispatchId).catch(() => ({ activity: 'unknown' }))
            task.activity = observed.activity
            task.waitReason = 'waitReason' in observed ? observed.waitReason : undefined
            if ('questions' in observed) task.questions = observed.questions
            if ('messages' in observed) task.messages = observed.messages
            if ('interaction' in observed) task.interaction = observed.interaction
            task.activityObservedAt = now()
            changed = true
          }
          if (await this.handleLiveLimit(run, step, task)) {
            changed = true
            continue
          }
          if (task.status !== 'running') {
            task.status = 'running'
            changed = true
          }
        } else if (rawStatus === 'pending' && task.status !== 'pending' && !ACTIVE.has(task.status)) {
          task.status = 'pending'
          changed = true
        }
      }
      if (run.scenario.version === 2) {
        const tasks = Object.values(run.tasks)
        if (tasks.length && !tasks.some(task => task.repairPending) && tasks.every(task => ['done', 'superseded', 'failed', 'skipped'].includes(task.status))) {
          if (tasks.some(task => task.status === 'failed')) run.status = 'failed'
          else await this.handlePr(run)
          changed = true
        }
      } else if (Object.values(run.tasks).length > 0 && Object.values(run.tasks).every((task) => !task.repairPending && (task.status === 'done' || task.status === 'superseded'))) {
        await this.handlePr(run)
        run.error = undefined
        changed = true
      } else if (Object.values(run.tasks).some((task) => task.status === 'failed')) {
        run.status = 'failed'
        for (const task of Object.values(run.tasks)) {
          if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'superseded') task.status = 'blocked'
        }
        changed = true
      }
      if (changed || run.error) {
        run.updatedAt = now()
        run.error = undefined
        await this.deps.save(run)
        this.deps.notify(run)
      }
    } catch (error) {
      await this.recordError(run, error)
    } finally {
      this.ticking.delete(id)
    }
  }

  private async handlePr(run: PipelineRun): Promise<void> {
    const config = run.scenario.pullRequest
    if (!config || run.pr?.status === 'merged') {
      run.status = 'done'
      return
    }
    if (run.pr?.status === 'failed') {
      run.status = 'failed'
      return
    }
    if (!this.deps.pr) {
      run.pr = { url: '', headRefOid: '', status: 'failed' }
      run.status = 'failed'
      run.error = 'PR client недоступен'
      return
    }
    if (!run.pr) {
      const created = await this.deps.pr.create(run.workspacePath, config.base)
      run.pr = { url: created.url, headRefOid: created.headRefOid, status: 'pending' }
    }
    const current = await this.deps.pr.checks(run.pr.url)
    const states = current.checks.map((check) => check.state.toLowerCase())
    if (states.some((state) => ['fail', 'failure', 'error', 'cancel', 'cancelled', 'canceled'].includes(state))) {
      run.pr.status = 'failed'
      run.status = 'failed'
      run.error = 'PR checks failed'
      return
    }
    if (states.some((state) => ['pending', 'expected', 'queued', 'in_progress'].includes(state))) {
      run.status = 'running'
      return
    }
    if (config.merge && config.mergeApproval) {
      const lastStep = run.scenario.steps.at(-1)!
      const lastTask = run.tasks[lastStep.id]
      if (!await this.approvalGranted(run, { ...lastStep, approval: config.mergeApproval }, lastTask)) {
        run.status = 'running'
        return
      }
    }
    if (config.merge) {
      await this.deps.pr.merge(run.pr.url, run.pr.headRefOid)
      run.pr.status = 'merged'
    } else {
      run.pr.status = 'approved'
    }
    run.status = 'done'
  }

  private async approvalGranted(run: PipelineRun, step: ScenarioStep, task: PipelineTask): Promise<boolean> {
    if (!task.gateId) {
      task.gateId = await this.deps.client.createGate(run.runId, run.coordinatorHandle, task.taskId, step.approval!)
      task.status = 'blocked'
      run.updatedAt = now()
      await this.deps.save(run)
      this.deps.notify(run)
      return false
    }
    const gates = await this.deps.client.listGates(run.runId, task.taskId)
    const gate = gates.find((candidate) => candidate.id === task.gateId) ?? gates[0]
    const resolution = String(gate?.resolution ?? '').toLowerCase()
    const status = String(gate?.status ?? '').toLowerCase()
    if (resolution === 'approve' || status === 'approved') return true
    if (resolution === 'reject' || status === 'rejected') {
      task.status = 'failed'
      task.error = 'Пользователь отклонил запуск шага'
      await this.syncBead(run, task)
      return false
    }
    task.status = 'blocked'
    return false
  }

  async resolveGate(id: string, stepId: string, resolution: 'approve' | 'reject'): Promise<void> {
    return this.control(id, () => this.resolveGateUnlocked(id, stepId, resolution))
  }

  private async resolveGateUnlocked(id: string, stepId: string, resolution: 'approve' | 'reject'): Promise<void> {
    const run = this.get(id)
    const task = run.tasks[stepId]
    if (!task?.gateId) throw new Error(`Для шага ${stepId} нет approval gate`)
    await this.deps.client.resolveGate(task.gateId, run.coordinatorHandle, resolution)
    await this.tick(id)
  }

  private async tryStartAttempt(run: PipelineRun, step: ScenarioStep, task: PipelineTask, sameAgent = false): Promise<void> {
    if (this.deferredStarts.has(run.id)) { task.status = 'pending'; task.retryRequested = true; task.retrySameAgent = sameAgent; return }
    try {
      await this.startAttempt(run, step, task, sameAgent)
    } catch (error) {
      task.retryRequested = undefined
      task.retrySameAgent = undefined
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      task.activity = 'startup-failed'; task.waitReason = undefined
      if (typeof workerResult(error).launchedTerminal === 'string') task.pendingTerminalHandle = workerResult(error).launchedTerminal as string
      if (workerResult(error).startOutcome === 'unknown') {
        task.status = 'blocked'; task.unconfirmedStart = true; task.activity = 'unknown'
        task.waitReason = 'Start outcome is unknown. Reconcile the existing worker before resume, retry or cancellation.'
        run.status = 'paused'
      }
      const details = workerResult(workerResult(error).details)
      if (Object.keys(details).length) this.deps.log(`Worker start ${step.id}: ${JSON.stringify(details)}`)
      const receipt = workerResult(details.result)
      if (receipt.runId === run.runId && receipt.taskId === task.taskId && typeof receipt.dispatchId === 'string' && receipt.state === 'failed') {
        task.startup = { dispatchId: receipt.dispatchId, terminalHandle: typeof workerResult(error).launchedTerminal === 'string' ? workerResult(error).launchedTerminal as string : undefined, stage: String(receipt.failedStage ?? receipt.stage ?? '') }
      }
      if (sameAgent && task.startup) task.retrySameAgent = true
      await this.syncBead(run, task)
    }
  }

  private async startAttempt(run: PipelineRun, step: ScenarioStep, task: PipelineTask, sameAgent = false): Promise<void> {
    const previous = task.attempts.at(-1)
    let agent = task.recoveryAgent ?? (sameAgent ? step.agent : previous ? nextAgent(step, task.attempts) : step.agent)
    let selectionReason = step.routingReason
    if (this.deps.usage && !sameAgent && !task.recoveryAgent) {
      const usage: Record<string, UsageWindow[]> = {}
      for (const candidate of [step.agent, ...step.fallback]) {
        usage[candidate] = await this.deps.usage.read(candidate).catch(() => [])
      }
      const selected = chooseAvailableAgent(step, task.attempts, usage, Date.now(), run.scenario.quotaThreshold ?? 95)
      agent = selected.agent
      selectionReason = selected.reason
    }
    if (!agent) {
      task.status = 'failed'
      task.error = selectionReason ?? 'Запасные агенты исчерпаны'
      return
    }
    if (this.deps.client.canStart && !this.deps.client.canStart(run, step, agent)) {
      task.status = 'ready'
      return
    }
    if (previous && !task.startup && this.deps.client.prepareRetry) {
      const replacementTask = await this.deps.client.prepareRetry(run, step, task)
      if (replacementTask) task.taskId = replacementTask
    }
    let handoff = previous ? handoffFor(step, task.attempts) : undefined
    if (handoff && step.role === 'evidence') {
      const repair = run.scenario.steps.filter(candidate => candidate.role === 'repair' && candidate.gateFor === step.gateFor && run.tasks[candidate.id]?.status === 'done').at(-1)
      const repaired = repair ? run.tasks[repair.id].attempts.at(-1) : undefined
      if (repaired) handoff += `\n\nLatest completed repair ${repair!.id}:\nChecks: ${JSON.stringify(repaired.checks ?? [])}\nArtifact: ${repaired.artifactPath ?? 'embedded below'}\n${repaired.output?.slice(-12_000) ?? 'No report'}`
    }
    if (this.deps.client.prepareCheckpoint && step.placement.host === 'local' && step.placement.worktree === 'current' && step.needs.length) {
      const inputs = step.needs.map(id => {
        const input = run.tasks[id]
        if (!input || !['done', 'superseded', 'skipped', 'failed'].includes(input.status)) throw new Error(`Pipeline input ${id} is not settled; no worker was started`)
        const attempt = input.attempts.at(-1)
        return { stepId: id, status: input.status, data: input.data, skipReason: input.skipReason, error: input.error, artifactPath: attempt?.artifactPath, reportPath: attempt?.reportPath, checks: attempt?.checks, report: attempt?.output }
      })
      handoff = `Pipeline predecessor results (runtime snapshot; statuses and checks are recorded separately from worker claims):\n${JSON.stringify(inputs, null, 2)}` + (handoff ? `\n\n${handoff}` : '')
    }
    if (handoff && this.deps.client.prepareCheckpoint) await this.deps.client.prepareCheckpoint(run, step, task.taskId, handoff)
    task.agent = agent
    await this.deps.save(run) // Preserve the chosen executor before an external start can become ambiguous.
    if (this.deferredStarts.has(run.id) || (this.ticking.has(run.id) && this.controls.has(run.id))) { task.status = 'pending'; task.retryRequested = true; task.retrySameAgent = sameAgent; return }
    task.activity = 'starting'; task.waitReason = 'Waiting for executor startup receipt'
    await this.deps.save(run)
    const retryOf = task.startup?.dispatchId ?? (previous?.taskId && previous.taskId !== task.taskId ? undefined : previous?.dispatchId)
    const dispatchId = await this.deps.client.startWorker(run, stepForAgent(step, agent), task.taskId, agent, retryOf, task.startup?.terminalHandle ?? task.pendingTerminalHandle)
    const attempt: Attempt = { dispatchId, taskId: task.taskId, agent, status: 'running', startedAt: now(), selectionReason }
    if (previous && previous.agent !== agent && handoff) {
      attempt.checkpointPreview = redactSecrets(handoff).slice(-4000)
    }
    task.recoveryAgent = undefined
    task.startup = undefined
    task.pendingTerminalHandle = undefined
    task.attempts.push(attempt)
    task.data = undefined; task.skipReason = undefined
    task.unconfirmedStart = undefined
    task.retryRequested = undefined
    task.retrySameAgent = undefined
    task.questions = []; task.messages = []; task.interaction = undefined
    task.activity = 'unknown'; task.activityObservedAt = undefined; task.waitReason = undefined
    task.agent = agent
    task.status = previous ? 'retrying' : 'running'
    task.error = undefined
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    if (handoff && !this.deps.client.prepareCheckpoint) {
      try {
        await this.deps.client.sendWorker(dispatchId, 'Continuation checkpoint', handoff, run.coordinatorHandle)
      } catch (error) {
        await this.deps.client.stopWorker(dispatchId).catch(() => undefined)
        attempt.status = 'failed'
        attempt.finishedAt = now()
        attempt.reason = 'handoff-delivery-failed'
        throw error
      }
    }
    await this.syncBead(run, task)
  }

  private async handleLiveLimit(run: PipelineRun, step: ScenarioStep, task: PipelineTask): Promise<boolean> {
    const last = task.attempts.at(-1)
    if (!last || last.status !== 'running') return false
    const output = await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    const observed = await this.deps.client.workerFailure?.(last.dispatchId).catch(() => undefined)
    const diagnostic = observed === undefined ? liveQuotaMessage(output) : undefined
    const failure = observed?.settled && observed.failure?.phase === 'executor' && observed.failure.kind === 'quota' ? observed.failure : undefined
    if (!diagnostic && !failure) return false
    if (!await this.deps.client.workerActivityDone(last.dispatchId).catch(() => false)) return false
    const replacement = task.attempts.length < step.maxAttempts ? nextAgent(step, task.attempts) : undefined
    // With no replacement, fence the assignment and retain the idle terminal for inspection.
    if (!replacement && this.deps.client.abandonWorker) await this.deps.client.abandonWorker(last.dispatchId)
    else await this.deps.client.stopWorker(last.dispatchId)
    last.output = output
    last.failure = failure ?? { version: 1, phase: 'executor', kind: 'quota', message: redactSecrets(diagnostic!).slice(0, 500) }
    last.status = 'failed'
    last.finishedAt = now()
    last.reason = 'quota'
    task.activity = 'failed'
    task.waitReason = undefined
    await this.captureAttempt(run, task, last)
    if (!replacement) {
      task.status = 'failed'
      task.error = `Лимит исчерпан, подходящих запасных агентов нет · ${failureMessage(last)}`
      await this.syncBead(run, task)
      await this.captureTaskState(run, task)
      return true
    }
    task.status = 'retrying'
    await this.syncBead(run, task)
    if (!this.schedulingAllowed(run)) {
      task.status = 'pending'; task.retryRequested = true; task.waitReason = 'Quota fallback is queued until scheduling resumes'
    } else await this.tryStartAttempt(run, step, task)
    await this.captureTaskState(run, task)
    return true
  }

  private async handleFailed(run: PipelineRun, step: ScenarioStep, task: PipelineTask, result: Record<string, unknown> = {}): Promise<void> {
    const last = task.attempts.at(-1)
    if (!last) {
      task.status = 'failed'
      task.error = 'Orca Task завершилась с ошибкой до запуска worker'
      return
    }
    const output = typeof result.body === 'string' ? result.body : await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    if (this.deps.client.workerObservation) {
      const observed = await this.deps.client.workerObservation(last.dispatchId).catch(() => undefined)
      if (observed?.questions) task.questions = observed.questions
      if (observed?.messages) task.messages = observed.messages
      if (observed?.interaction) task.interaction = observed.interaction
      if (observed) task.waitReason = observed.waitReason
    }
    let failure = failureInfo(result.failure), review: ReviewResult | undefined
    if (step.role === 'evidence') {
      try { review = reviewResult(result, output); if (review) result.review = review }
      catch (error) { failure = { version: 1, phase: 'validation', kind: 'unknown', message: error instanceof Error ? error.message : String(error) }; result.failure = failure }
    }
    if (review && review.verdict !== 'SHIP' && (!failure || failure.phase === 'executor')) {
      failure = { version: 1, phase: 'review', kind: 'unknown', message: 'Evidence verdict: ' + review.verdict }; result.failure = failure
    }
    applyEvidence(last, result)
    last.status = 'failed'
    last.finishedAt = now()
    last.output = output
    task.activity = 'failed'; task.waitReason = undefined
    if (step.role === 'evidence' && failure?.phase !== 'cancellation') {
      if (failure?.phase === 'acceptance' && (!review || review.verdict === 'SHIP')) review = { version: 1, verdict: 'FIX-FIRST', findings: 'Runtime acceptance rejected the result: ' + failure.message }
      if ((review && review.verdict !== 'SHIP') || (!review && !failure && /FIX-FIRST|BLOCKED/i.test(output))) {
        await this.handleEvidenceVerdict(run, step, task, output, review); await this.captureAttempt(run, task, last); return
      }
    }
    const isWorkerReport = result.provenance === 'worker_report'
    const kind = failure ? failure.phase === 'executor' ? failure.kind : failure.phase === 'cancellation' ? 'cancelled' : failure.phase : isWorkerReport ? 'unknown' : classifyFailure(output)
    last.reason = kind === 'unknown' && isWorkerReport ? 'worker-reported-failure' : kind
    await this.captureAttempt(run, task, last)
    const replacement = kind === 'quota' && task.attempts.length < step.maxAttempts ? nextAgent(step, task.attempts) : undefined
    if (replacement && this.schedulingAllowed(run)) {
      task.status = 'retrying'
      await this.syncBead(run, task)
      await this.tryStartAttempt(run, step, task)
      return
    }
    if (replacement && ['running', 'paused'].includes(run.status)) {
      task.status = 'pending'; task.retryRequested = true; task.waitReason = 'Quota fallback is queued until scheduling resumes'
      await this.syncBead(run, task); return
    }
    task.status = 'failed'
    task.error = kind === 'quota' ? 'Лимит исчерпан, подходящих запасных агентов нет' : failureMessage(last, result.subject)
    await this.syncBead(run, task)
  }

  private async handleEvidenceVerdict(run: PipelineRun, step: ScenarioStep, task: PipelineTask, output: string, review?: ReviewResult): Promise<void> {
    const last = task.attempts.at(-1)!
    last.status = 'failed'
    last.finishedAt = now()
    const verdict = review?.verdict ?? (/FIX-FIRST/i.test(output) ? 'FIX-FIRST' : 'BLOCKED')
    last.reason = verdict === 'FIX-FIRST' ? 'fix-first' : 'blocked'
    last.output = output
    const original = run.scenario.steps.find((candidate) => candidate.id === step.gateFor)
    const round = (step.repairRound ?? 0) + 1
    if (verdict === 'FIX-FIRST' && original && round <= step.maxRepairs) {
      if (!this.schedulingAllowed(run)) {
        task.status = 'superseded'; task.repairPending = true; task.error = 'FIX-FIRST: исправление ожидает продолжения планирования'
        await this.syncBead(run, task); await this.deps.save(run); return
      }
      const repairId = `${original.id}-repair-${round}`
      const repair: ScenarioStep = {
        ...original,
        id: repairId,
        title: `Исправление ${round}: ${original.title}`,
        spec: `${original.spec}\n\nИсправь замечания Evidence Gate:\n${review ? review.findings + '\n' : ''}${output}`,
        needs: [run.scenario.steps.find(candidate => candidate.role === 'repair' && candidate.gateFor === original.id && candidate.repairRound === round - 1)?.id ?? original.id],
        when: undefined, join: undefined,
        reviewAgent: undefined,
        role: 'repair',
        gateFor: original.id,
        repairRound: round
      }
      const repairTaskId = await this.deps.client.createTask(run.runId, run.coordinatorHandle, repair, taskSpec(repair, undefined, run.runId, true, run.workspacePath), run.scenario.version === 2 ? [] : repair.needs.map(id => run.tasks[id].taskId))
      step.repairRound = round
      task.repairPending = undefined
      run.scenario.steps.push(repair)
      run.tasks[repair.id] = { stepId: repair.id, taskId: repairTaskId, status: 'pending', agent: repair.agent, attempts: [] }
      task.status = 'superseded'
      task.error = 'FIX-FIRST: создано исправление'
      await this.createBeads(run)
      await this.syncBead(run, task)
      run.updatedAt = now()
      await this.deps.save(run)
      return
    }
    task.status = 'failed'
    task.error = verdict === 'FIX-FIRST' ? 'Evidence Gate: лимит исправлений исчерпан' : 'Evidence Gate: BLOCKED'
    await this.syncBead(run, task)
  }

  private async retryEvidenceAfterRepair(run: PipelineRun, repair: ScenarioStep): Promise<void> {
    const evidence = run.scenario.steps.find((candidate) => candidate.role === 'evidence' && candidate.gateFor === repair.gateFor)
    if (!evidence) return
    const task = run.tasks[evidence.id]
    if (!task || task.status !== 'superseded') return
    evidence.needs = [repair.id]
    if (!this.schedulingAllowed(run)) { task.status = 'pending'; task.retryRequested = true; task.retrySameAgent = true; return }
    task.status = 'retrying'; task.error = undefined
    await this.tryStartAttempt(run, evidence, task, true)
  }

  private async finishAttempt(run: PipelineRun, task: PipelineTask, status: Attempt['status'], result: Record<string, unknown> = {}): Promise<void> {
    const last = task.attempts.at(-1)
    if (!last) return
    last.status = status
    last.finishedAt = now()
    last.output = typeof result.body === 'string' ? result.body : await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    task.activity = status === 'done' ? 'done' : 'failed'
    if (this.deps.client.workerObservation) {
      const observed = await this.deps.client.workerObservation(last.dispatchId).catch(() => undefined)
      if (observed?.questions) task.questions = observed.questions
      if (observed?.messages) task.messages = observed.messages
      if (observed?.interaction) task.interaction = observed.interaction
      if (observed?.waitReason === undefined) task.waitReason = undefined
    }
    applyEvidence(last, result)
    await this.captureAttempt(run, task, last)
    if (!run.visibleWorkers) await this.deps.client.releaseWorker(last.dispatchId).catch(() => undefined)
  }

  private async captureAttempt(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<void> {
    if (!this.deps.artifacts) return
    try {
      await this.deps.artifacts.save(run, task, attempt)
    } catch (error) {
      this.deps.log(`Artifact: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async captureTaskState(run: PipelineRun, task: PipelineTask): Promise<void> {
    if (!this.deps.artifacts?.saveState) return
    try { await this.deps.artifacts.saveState(run, task) }
    catch (error) { this.deps.log('Task state artifact: ' + (error instanceof Error ? error.message : String(error))) }
  }

  private async syncBead(run: PipelineRun, task: PipelineTask): Promise<void> {
    if (!task.beadId || !this.deps.beadsFor) return
    try {
      await this.deps.beadsFor(run.workspacePath).sync(run, task)
    } catch (error) {
      this.deps.log(`Beads sync: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async refreshPendingContext(id: string, stepId: string): Promise<void> {
    await this.control(id, async () => {
      const run = this.get(id), task = run.tasks[stepId], step = run.scenario.steps.find(step => step.id === stepId)
      if (!step || !task || task.attempts.length || task.startup || task.unconfirmedStart || !['pending', 'blocked', 'ready'].includes(task.status)) throw new Error('Обновление контекста доступно только ещё не запускавшемуся шагу')
      if (!this.deps.client.reviseTask || step.placement.host !== 'local' || step.placement.worktree !== 'current') throw new Error('Этот backend не поддерживает обновление локального контекста')
      const revision = (task.revision ?? 0) + 1
      const taskId = await this.deps.client.reviseTask(run, step, revision, taskSpec(step, undefined, run.runId, true, run.workspacePath), run.scenario.version === 2 ? [] : step.needs.map(id => run.tasks[id].taskId))
      ;(task.history ??= []).push({ revision: task.revision ?? 0, taskId: task.taskId, status: task.status, agent: task.agent, attempts: [] })
      task.taskId = taskId; task.revision = revision; task.status = 'pending'
      await this.deps.save(run); this.deps.notify(run)
    })
  }

  async excludeInvalidSteps(id: string, stepIds: string[], reason: string): Promise<void> {
    await this.control(id, async () => {
      const run = this.get(id), selected = new Set(stepIds)
      if (!reason.trim() || !selected.size) throw new Error('Укажите шаги и причину исключения')
      if (run.status !== 'failed' && run.status !== 'paused') throw new Error('Сначала остановите планирование pipeline')
      for (const stepId of selected) {
        const task = run.tasks[stepId]
        if (!task || !['failed', 'pending', 'blocked', 'ready'].includes(task.status) || task.attempts.at(-1)?.status === 'running' || task.startup || task.unconfirmedStart) throw new Error(`Шаг ${stepId} завершён успешно или имеет незавершённое исполнение; исключение запрещено`)
      }
      if (run.scenario.steps.some(step => !selected.has(step.id) && step.needs.some(parent => selected.has(parent)))) throw new Error('Оставшийся шаг зависит от исключаемого; сначала исправьте состав исключения')
      for (const step of run.scenario.steps.filter(step => selected.has(step.id))) {
        (run.excludedSteps ??= []).push({ step: structuredClone(step), task: structuredClone(run.tasks[step.id]), reason: reason.trim(), excludedAt: now() })
        delete run.tasks[step.id]
      }
      run.scenario = { ...run.scenario, steps: run.scenario.steps.filter(step => !selected.has(step.id)) }
      run.updatedAt = now(); await this.deps.save(run); this.deps.notify(run)
    })
  }

  async pause(id: string): Promise<void> {
    return this.control(id, () => this.pauseUnlocked(id))
  }

  private async pauseUnlocked(id: string): Promise<void> {
    const run = this.get(id)
    run.status = 'paused'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }

  async resume(id: string): Promise<void> {
    return this.control(id, () => this.resumeUnlocked(id))
  }

  private async resumeUnlocked(id: string): Promise<void> {
    const run = this.get(id)
    if (run.status === 'done' || run.status === 'cancelled') throw new Error('Завершённый или отменённый запуск нельзя продолжить; создайте новый запуск')
    await this.completeRevisions(run)
    if (Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks)) {
      if (!this.deps.client.reconcile) throw new Error('This backend must reconcile the unconfirmed start before resuming')
      await this.deps.client.reconcile(run)
      if (Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks)) throw new Error('Start or acceptance outcome remains unknown; no replacement was started')
    }
    await this.deps.client.bindRun(run.runId, run.coordinatorHandle)
    run.status = 'running'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    void this.tick(id)
  }

  async retry(id: string): Promise<void> {
    return this.control(id, () => this.retryUnlocked(id))
  }

  private async retryUnlocked(id: string): Promise<void> {
    const run = this.get(id)
    if (Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks)) throw new Error('Reconcile the unconfirmed start/acceptance before retrying')
    if (run.status !== 'failed') throw new Error('Повторять можно только failed pipeline')
    let failed = run.scenario.steps.filter((step) => run.tasks[step.id]?.status === 'failed')
    const descendants = (ids: string[]) => {
      const found = new Set<string>(), pending = new Set(ids)
      while (pending.size) {
        const next = [...pending]; pending.clear()
        for (const step of run.scenario.steps) if (!found.has(step.id) && step.needs.some(id => next.includes(id))) { found.add(step.id); pending.add(step.id) }
      }
      return found
    }
    if (run.scenario.version === 2) failed = failed.filter(step => !failed.some(other => other.id !== step.id && descendants([other.id]).has(step.id)))
    const affected = run.scenario.version === 2 ? descendants(failed.map(step => step.id)) : new Set<string>()
    if (affected.size && !this.deps.client.reviseTask) throw new Error('Backend cannot recompute dependent results. Start a new run from this scenario; stale results were not reused.')
    if (Object.values(run.tasks).some(task => task.attempts.at(-1)?.status === 'running')) throw new Error('Observe or stop the active workers before retrying')
    for (const step of failed) {
      const task = run.tasks[step.id]
      if (!task.attempts.length && !task.startup && this.deps.client.failedStartup) task.startup = await this.deps.client.failedStartup(run.runId, task.taskId)
      // Recover old snapshots which lost the same-reviewer intent when its
      // post-repair launch was rejected before task input acceptance.
      if (step.role === 'evidence' && task.startup && task.attempts.at(-1)?.review?.verdict === 'FIX-FIRST'
        && step.needs.some(id => { const repair = run.scenario.steps.find(candidate => candidate.id === id); return repair?.role === 'repair' && repair.gateFor === step.gateFor && repair.repairRound === step.repairRound && run.tasks[id]?.status === 'done' })) task.retrySameAgent = true
      if (!task.retrySameAgent && (task.attempts.length >= step.maxAttempts || !nextAgent(step, task.attempts))) {
        throw new Error(`Для шага ${step.title} не осталось fallback-агентов`)
      }
    }
    if (run.scenario.version === 2) {
      // Journal invalidation before external Task creation. A crash leaves a
      // paused run with resumable, idempotent revisions rather than stale success.
      run.status = 'paused'; run.error = undefined
      for (const step of run.scenario.steps.filter(step => affected.has(step.id))) {
        const task = run.tasks[step.id]
        const { taskId, status, agent, attempts, data, error, skipReason, gateId } = task
        const history = [...(task.history ?? []), { revision: task.revision ?? 0, taskId, status, agent, attempts, data, error, skipReason, gateId }]
        run.tasks[step.id] = { stepId: step.id, taskId, status: 'pending', agent: step.agent, attempts: [], history, revision: (task.revision ?? 0) + 1, revisionPending: true, retryRequested: true }
      }
      for (const step of failed) { const task = run.tasks[step.id]; task.status = 'pending'; task.error = undefined; task.retryRequested = true }
      run.updatedAt = now(); await this.deps.save(run)
      await this.completeRevisions(run)
      await this.deps.client.bindRun(run.runId, run.coordinatorHandle)
      run.status = 'running'; run.updatedAt = now(); await this.deps.save(run); this.deps.notify(run)
      return // Scheduler rechecks conditions, joins, capacity and approvals before each retry.
    }
    await this.deps.client.bindRun(run.runId, run.coordinatorHandle)
    run.status = 'running'
    run.error = undefined
    for (const task of Object.values(run.tasks)) {
      if (task.status === 'blocked') task.status = 'pending'
    }
    for (const step of failed) {
      const task = run.tasks[step.id]
      task.status = 'retrying'
      await this.tryStartAttempt(run, step, task, task.retrySameAgent === true)
    }
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    await this.tick(id)
  }

  private async completeRevisions(run: PipelineRun): Promise<void> {
    for (const step of waves(run.scenario.steps).flat()) {
      const task = run.tasks[step.id]
      if (!task?.revisionPending) continue
      if (!this.deps.client.reviseTask) throw new Error('Backend cannot recover the pending dependent result revision')
      task.taskId = await this.deps.client.reviseTask(run, step, task.revision!, taskSpec(step, undefined, run.runId, true, run.workspacePath) + `\n\nInput revision: ${task.revision}. Previous results are historical; inspect current predecessor state.`, [])
      if (this.deps.client.prepareCheckpoint) await this.deps.client.prepareCheckpoint(run, step, task.taskId, `Input revision ${task.revision}. Earlier attempts and their continuation checkpoints are historical. Use the current predecessor reports and state; do not reuse an earlier verdict.`)
      task.revisionPending = undefined
      await this.captureTaskState(run, task)
      await this.deps.save(run)
    }
  }

  async queueRecoveryAgent(id: string, stepId: string, agent: string): Promise<void> {
    return this.control(id, async () => {
      const run = this.get(id), step = run.scenario.steps.find(item => item.id === stepId), task = run.tasks[stepId]
      if (!step || !task || run.status !== 'failed' || task.status !== 'failed' || task.unconfirmedStart || task.attempts.at(-1)?.status === 'running' || !step.fallback.includes(agent)) throw new Error('Резервный агент не разрешён или предыдущий исполнитель не сверён.')
      task.recoveryAgent = agent
      await this.deps.save(run)
    })
  }

  async assignAgent(id: string, stepId: string, agent: string): Promise<void> {
    return this.control(id, () => this.assignAgentUnlocked(id, stepId, agent))
  }

  async applyAgentRouting(id: string, draft: Scenario): Promise<void> {
    await this.control(id, async () => {
      const run = this.get(id)
      if (run.status !== 'failed' || Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks || task.startup || task.attempts.at(-1)?.status === 'running')) {
        throw new Error('Agent settings can only be applied to a failed run with settled attempts.')
      }
      // Compare the representation used by storage, which omits undefined fields.
      const [saved, proposed] = [run.scenario, draft].map((scenario): Scenario => JSON.parse(JSON.stringify(scenario)))
      const { steps: savedSteps, ...savedSettings } = saved
      const { steps: draftSteps, ...draftSettings } = proposed
      const planned = new Map(draftSteps.map(step => [step.id, agentRouting(step)]))
      if (!isDeepStrictEqual(savedSettings, draftSettings) || planned.size !== savedSteps.length || savedSteps.some(step => !isDeepStrictEqual(agentRouting(step).instructions, planned.get(step.id)?.instructions))) {
        throw new Error('The draft must match the saved run apart from agent settings.')
      }
      for (const step of run.scenario.steps) {
        const task = run.tasks[step.id]
        if (!task || ['done', 'skipped', 'superseded'].includes(task.status)) continue
        const { routing } = planned.get(step.id)!
        if (!isDeepStrictEqual(agentRouting(step).routing, routing)) {
          Object.assign(step, routing)
          task.agent = routing.agent
          task.recoveryAgent = undefined
          task.pendingTerminalHandle = undefined
          if (task.status === 'failed') task.retrySameAgent = true
        }
      }
      run.updatedAt = now()
      await this.deps.save(run)
      this.deps.notify(run)
    })
  }

  private async assignAgentUnlocked(id: string, stepId: string, agent: string): Promise<void> {
    if (!/^[\w.-]+$/.test(agent)) throw new Error('Некорректный агент')
    const run = this.get(id)
    const step = run.scenario.steps.find(step => step.id === stepId)
    const task = run.tasks[stepId]
    if (!step || !task || run.status !== 'failed' || task.status !== 'failed') throw new Error('Сменить исполнителя можно у failed шага остановленного pipeline')
    if (task.attempts.at(-1)?.status === 'running') throw new Error('Сначала остановите работающего исполнителя')
    const startup = await this.deps.client.failedStartup?.(run.runId, task.taskId)
    step.agent = agent
    task.pendingTerminalHandle = undefined
    step.fallback = step.fallback.filter(item => item !== agent)
    task.agent = agent
    if (startup) task.startup = { dispatchId: startup.dispatchId, stage: startup.stage }
    else task.startup = undefined
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }

  async cancel(id: string): Promise<void> {
    return this.control(id, () => this.cancelUnlocked(id))
  }

  private async cancelUnlocked(id: string): Promise<void> {
    const run = this.get(id)
    run.status = 'paused'
    run.updatedAt = now()
    await this.deps.save(run)
    if (Object.values(run.tasks).some(task => task.unconfirmedStart)) throw new Error('Reconcile the unconfirmed start before cancellation; no worker exit was assumed')
    for (const task of Object.values(run.tasks)) {
      const attempt = task.attempts.at(-1)
      if (!attempt && task.startup) await this.deps.client.stopWorker(task.startup.dispatchId)
      if (attempt?.status === 'running') {
        const partial = await this.deps.client.workerOutput(attempt.dispatchId).catch(() => attempt.output ?? '')
        if (partial) { attempt.output = partial; await this.captureAttempt(run, task, attempt); await this.deps.save(run) }
        await this.deps.client.stopWorker(attempt.dispatchId)
        attempt.reason = 'cancelled'
        const result = await this.deps.client.settledResult?.(attempt.dispatchId).catch(() => undefined) ?? {}
        if (typeof result.body !== 'string' && typeof result.text !== 'string' && partial) result.body = partial
        result.failure ??= { version: 1, phase: 'cancellation', kind: 'unknown', message: 'Run cancelled; completed worker evidence retained' }
        await this.finishAttempt(run, task, 'failed', result)
        task.unconfirmedChecks = undefined
        task.activity = 'stopped'; task.waitReason = undefined
      }
      if (task.status !== 'done' && task.status !== 'skipped') task.status = 'blocked'
      task.repairPending = undefined
    }
    run.status = 'cancelled'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }

  async switchAgent(id: string, stepId: string): Promise<void> {
    return this.control(id, () => this.switchAgentUnlocked(id, stepId))
  }

  private async switchAgentUnlocked(id: string, stepId: string): Promise<void> {
    const run = this.get(id)
    const step = run.scenario.steps.find((candidate) => candidate.id === stepId)
    const task = run.tasks[stepId]
    if (!step || !task) throw new Error(`Шаг ${stepId} не найден`)
    const last = task.attempts.at(-1)
    if (!last || last.status !== 'running') throw new Error('Переключать можно только активный Dispatch')
    if (task.attempts.length >= step.maxAttempts) throw new Error('Лимит попыток исчерпан')
    const replacement = nextAgent(step, task.attempts)
    if (!replacement) throw new Error('Запасные агенты исчерпаны')
    last.output = await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    await this.deps.client.stopWorker(last.dispatchId)
    last.status = 'failed'
    last.finishedAt = now()
    last.reason = 'manual-switch'
    task.status = 'retrying'
    await this.startAttempt(run, step, task)
  }

  private async recordError(run: PipelineRun, error: unknown): Promise<void> {
    run.error = error instanceof Error ? error.message : String(error)
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }
}
