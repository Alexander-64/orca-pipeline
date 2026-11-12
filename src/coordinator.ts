import { randomUUID } from 'node:crypto'
import { workspaceSelector, type OrcaClient } from './cli'
import type { BeadsClient } from './beads'
import type { AttemptArtifactStore } from './artifacts'
import { hasCapacity } from './capacity'
import { classifyFailure, handoffFor, nextAgent } from './failover'
import { chooseAvailableAgent, type UsageReader, type UsageWindow } from './quota'
import type { PrClient } from './pr'
import { taskSpec } from './scenario'
import type { Attempt, PipelineRun, PipelineTask, Scenario, ScenarioStep, Workspace } from './types'

type Deps = {
  client: OrcaClient
  beadsFor: (workspacePath: string) => BeadsClient
  usage?: UsageReader
  artifacts?: AttemptArtifactStore
  pr?: PrClient
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

export class Coordinator {
  private readonly runs = new Map<string, PipelineRun>()
  private readonly ticking = new Set<string>()

  constructor(private readonly deps: Deps) {}

  list(): PipelineRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): PipelineRun {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Запуск ${id} не найден`)
    return run
  }

  restore(runs: PipelineRun[]): void {
    for (const run of runs) {
      this.runs.set(run.id, run)
      if (run.status === 'running') void this.deps.client.bindRun(run.runId, run.coordinatorHandle)
        .then(() => this.tick(run.id))
        .catch((error: unknown) => this.recordError(run, error))
    }
  }

  async start(workspace: Workspace, coordinatorHandle: string, scenario: Scenario): Promise<PipelineRun> {
    const createdAt = now()
    const runId = await this.deps.client.createRun(scenario.objective, coordinatorHandle)
    const run: PipelineRun = {
      id: randomUUID(),
      runId,
      coordinatorHandle,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceSelector: workspaceSelector(workspace),
      scenario,
      status: 'running',
      tasks: {},
      createdAt,
      updatedAt: createdAt
    }
    this.runs.set(run.id, run)
    await this.deps.save(run)
    try {
      const remaining = new Map(scenario.steps.map((step) => [step.id, step]))
      while (remaining.size) {
        const step = [...remaining.values()].find((candidate) => candidate.needs.every((id) => run.tasks[id]?.taskId))
        if (!step) throw new Error('Не удалось упорядочить шаги сценария')
        const dependencies = step.needs.map((id) => run.tasks[id].taskId)
        const taskId = await this.deps.client.createTask(runId, coordinatorHandle, step, taskSpec(step), dependencies)
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
    }
    this.deps.notify(run)
    await this.tick(run.id)
    return run
  }

  private async createBeads(run: PipelineRun): Promise<void> {
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
    if (this.ticking.has(id)) return
    const run = this.get(id)
    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return
    this.ticking.add(id)
    try {
      const rawTasks = await this.deps.client.listTasks(run.runId)
      const rawById = new Map(rawTasks.map((task) => [String(task.id), task]))
      let changed = false
      for (const step of run.scenario.steps) {
        const task = run.tasks[step.id]
        if (!task) continue
        const rawStatus = statusOf(rawById.get(task.taskId)?.status)
        if (DONE.has(rawStatus)) {
          if (task.status !== 'done') {
            await this.finishAttempt(run, task, 'done', workerResult(rawById.get(task.taskId)?.result))
            task.status = 'done'
            task.error = undefined
            changed = true
            await this.syncBead(run, task)
            if (step.role === 'repair') await this.retryEvidenceAfterRepair(run, step)
          }
          continue
        }
        if (FAILED.has(rawStatus)) {
          if ((task.status !== 'failed' && task.status !== 'superseded') || ACTIVE.has(task.status)) {
            await this.handleFailed(run, step, task)
            changed = true
          }
          continue
        }
        if (rawStatus === 'ready' && run.status === 'running' && hasCapacity(run.scenario, run.tasks, step) && !ACTIVE.has(task.status) && task.status !== 'done' && task.status !== 'failed') {
          task.status = 'ready'
          if (step.approval && !await this.approvalGranted(run, step, task)) {
            changed = true
            continue
          }
          await this.tryStartAttempt(run, step, task)
          changed = true
          continue
        }
        if (rawStatus === 'dispatched' || rawStatus === 'running') {
          if (run.status === 'running' && await this.handleLiveLimit(run, step, task)) {
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
      if (Object.values(run.tasks).length > 0 && Object.values(run.tasks).every((task) => task.status === 'done' || task.status === 'superseded')) {
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
    if (states.some((state) => ['fail', 'failure', 'error', 'cancelled', 'canceled'].includes(state))) {
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
    const run = this.get(id)
    const task = run.tasks[stepId]
    if (!task?.gateId) throw new Error(`Для шага ${stepId} нет approval gate`)
    await this.deps.client.resolveGate(task.gateId, run.coordinatorHandle, resolution)
    await this.tick(id)
  }

  private async tryStartAttempt(run: PipelineRun, step: ScenarioStep, task: PipelineTask, sameAgent = false): Promise<void> {
    try {
      await this.startAttempt(run, step, task, sameAgent)
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      await this.syncBead(run, task)
    }
  }

  private async startAttempt(run: PipelineRun, step: ScenarioStep, task: PipelineTask, sameAgent = false): Promise<void> {
    const previous = task.attempts.at(-1)
    let agent = sameAgent ? step.agent : previous ? nextAgent(step, task.attempts) : step.agent
    let selectionReason = step.routingReason
    if (this.deps.usage && !sameAgent) {
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
    const handoff = previous ? handoffFor(step, task.attempts) : undefined
    const dispatchId = await this.deps.client.startWorker(run, step, task.taskId, agent, previous?.dispatchId)
    const attempt: Attempt = { dispatchId, agent, status: 'running', startedAt: now(), selectionReason }
    task.attempts.push(attempt)
    task.agent = agent
    task.status = previous ? 'retrying' : 'running'
    task.error = undefined
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    if (handoff) {
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
    if (!last || last.status !== 'running' || task.attempts.length >= step.maxAttempts || !nextAgent(step, task.attempts)) return false
    const output = await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    if (classifyFailure(output) !== 'quota') return false
    if (!await this.deps.client.workerActivityDone(last.dispatchId).catch(() => false)) return false
    last.output = output
    await this.captureAttempt(run, task, last)
    await this.deps.client.stopWorker(last.dispatchId)
    last.status = 'failed'
    last.finishedAt = now()
    last.reason = 'quota'
    task.status = 'retrying'
    await this.syncBead(run, task)
    await this.tryStartAttempt(run, step, task)
    return true
  }

  private async handleFailed(run: PipelineRun, step: ScenarioStep, task: PipelineTask): Promise<void> {
    const last = task.attempts.at(-1)
    if (!last) {
      task.status = 'failed'
      task.error = 'Orca Task завершилась с ошибкой до запуска worker'
      return
    }
    const output = await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    await this.captureAttempt(run, task, last)
    if (step.role === 'evidence' && /FIX-FIRST|BLOCKED/i.test(output)) {
      await this.handleEvidenceVerdict(run, step, task, output)
      return
    }
    const kind = classifyFailure(output)
    last.status = 'failed'
    last.finishedAt = now()
    last.reason = kind
    last.output = output
    const replacement = kind === 'quota' && task.attempts.length < step.maxAttempts ? nextAgent(step, task.attempts) : undefined
    if (replacement && run.status === 'running') {
      task.status = 'retrying'
      await this.syncBead(run, task)
      await this.tryStartAttempt(run, step, task)
      return
    }
    task.status = 'failed'
    task.error = kind === 'quota' ? 'Лимит исчерпан, подходящих запасных агентов нет' : `Исполнитель завершился: ${kind}`
    await this.syncBead(run, task)
  }

  private async handleEvidenceVerdict(run: PipelineRun, step: ScenarioStep, task: PipelineTask, output: string): Promise<void> {
    const last = task.attempts.at(-1)!
    last.status = 'failed'
    last.finishedAt = now()
    last.reason = /FIX-FIRST/i.test(output) ? 'fix-first' : 'blocked'
    last.output = output
    const original = run.scenario.steps.find((candidate) => candidate.id === step.gateFor)
    const round = (step.repairRound ?? 0) + 1
    if (/FIX-FIRST/i.test(output) && original && round <= step.maxRepairs && run.status === 'running') {
      const repairId = `${original.id}-repair-${round}`
      const repair: ScenarioStep = {
        ...original,
        id: repairId,
        title: `Исправление ${round}: ${original.title}`,
        spec: `${original.spec}\n\nИсправь замечания Evidence Gate:\n${output}`,
        needs: [original.id],
        reviewAgent: undefined,
        role: 'repair',
        gateFor: original.id,
        repairRound: round
      }
      const repairTaskId = await this.deps.client.createTask(run.runId, run.coordinatorHandle, repair, taskSpec(repair), [run.tasks[original.id].taskId])
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
    task.error = /FIX-FIRST/i.test(output) ? 'Evidence Gate: лимит исправлений исчерпан' : 'Evidence Gate: BLOCKED'
    await this.syncBead(run, task)
  }

  private async retryEvidenceAfterRepair(run: PipelineRun, repair: ScenarioStep): Promise<void> {
    const evidence = run.scenario.steps.find((candidate) => candidate.role === 'evidence' && candidate.gateFor === repair.gateFor)
    if (!evidence) return
    const task = run.tasks[evidence.id]
    if (!task || task.status !== 'superseded') return
    task.status = 'retrying'
    await this.tryStartAttempt(run, evidence, task, true)
  }

  private async finishAttempt(run: PipelineRun, task: PipelineTask, status: Attempt['status'], result: Record<string, unknown> = {}): Promise<void> {
    const last = task.attempts.at(-1)
    if (!last) return
    last.status = status
    last.finishedAt = now()
    last.output = await this.deps.client.workerOutput(last.dispatchId).catch(() => '')
    const files = result.filesModified ?? result.files_modified
    if (Array.isArray(files)) last.filesModified = files.filter((file): file is string => typeof file === 'string')
    await this.captureAttempt(run, task, last)
    await this.deps.client.releaseWorker(last.dispatchId).catch(() => undefined)
  }

  private async captureAttempt(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<void> {
    if (!this.deps.artifacts) return
    try {
      await this.deps.artifacts.save(run, task, attempt)
    } catch (error) {
      this.deps.log(`Artifact: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async syncBead(run: PipelineRun, task: PipelineTask): Promise<void> {
    if (!task.beadId) return
    try {
      await this.deps.beadsFor(run.workspacePath).sync(run, task)
    } catch (error) {
      this.deps.log(`Beads sync: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async pause(id: string): Promise<void> {
    const run = this.get(id)
    run.status = 'paused'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }

  async resume(id: string): Promise<void> {
    const run = this.get(id)
    await this.deps.client.bindRun(run.runId, run.coordinatorHandle)
    run.status = 'running'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    void this.tick(id)
  }

  async retry(id: string): Promise<void> {
    const run = this.get(id)
    if (run.status !== 'failed') throw new Error('Повторять можно только failed pipeline')
    const failed = run.scenario.steps.filter((step) => run.tasks[step.id]?.status === 'failed')
    for (const step of failed) {
      const task = run.tasks[step.id]
      if (task.attempts.length >= step.maxAttempts || !nextAgent(step, task.attempts)) {
        throw new Error(`Для шага ${step.title} не осталось fallback-агентов`)
      }
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
      await this.tryStartAttempt(run, step, task)
    }
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
    await this.tick(id)
  }

  async cancel(id: string): Promise<void> {
    const run = this.get(id)
    run.status = 'paused'
    for (const task of Object.values(run.tasks)) {
      const attempt = task.attempts.at(-1)
      if (attempt?.status === 'running') {
        await this.deps.client.stopWorker(attempt.dispatchId)
        attempt.status = 'failed'
        attempt.finishedAt = now()
        attempt.reason = 'cancelled'
      }
      if (task.status !== 'done') task.status = 'blocked'
    }
    run.status = 'cancelled'
    run.updatedAt = now()
    await this.deps.save(run)
    this.deps.notify(run)
  }

  async switchAgent(id: string, stepId: string): Promise<void> {
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
