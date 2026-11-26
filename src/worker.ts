import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectOptions } from './projects'
import type { OrcaWorkerApi } from 'orca/worker'
import { ArtifactStore } from './artifacts'
import { BeadsClient } from './beads'
import { OrcaClient } from './cli'
import { Coordinator, assertRunVersions } from './coordinator'
import { readModelCatalog } from './model-catalog'
import { discoverAgents } from './agents'
import { Planner } from './planner'
import { metricsForRuns } from './metrics'
import { GhPrClient } from './pr'
import { StorageMutationJournal } from './mutations'
import { listScenarios, openScenario, saveScenario } from './scenarioFiles'
import { parseScenario, workspaceRestrictionConflicts } from './scenario'
import { CodexUsageReader } from './usage'
import { TerminalRunBridge } from './terminal-bridge'
import { ChunkedJsonStorage } from '../packages/core/chunked-storage'
import type { Bead, Dashboard, PipelineRun, PlannerRun, Workspace, RecoveryReport } from './types'

const RUNS_KEY = 'pipeline.runs.v1'
let pollingTimer: ReturnType<typeof setInterval> | undefined

async function storedRuns(storage: ChunkedJsonStorage): Promise<PipelineRun[]> {
  const value = await storage.get(RUNS_KEY)
  return Array.isArray(value) ? value as PipelineRun[] : []
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export default function activate(orca: OrcaWorkerApi): void {
  const storage = new ChunkedJsonStorage(orca.storage)
  let beadsExecutable = 'bd'
  let beadsEnabled = false
  let recoveryWarning: string | undefined
  let affectedRuns: Set<string> | undefined
  const isBlocked = (id?: string) => !!recoveryWarning && (!affectedRuns || !id || affectedRuns.has(id))
  let recovering = true
  const client = new OrcaClient(undefined, undefined, new StorageMutationJournal(orca.storage))
  const terminalBridge = new TerminalRunBridge()
  const beadsFor = (workspacePath: string) => new BeadsClient(workspacePath, undefined, beadsExecutable)
  const save = async (run: PipelineRun) => {
    const runs = coordinator.list().map((candidate) => candidate.id === run.id ? run : candidate)
    await storage.set(RUNS_KEY, json(runs))
  }
  const coordinatorDeps: ConstructorParameters<typeof Coordinator>[0] = {
    client,
    usage: new CodexUsageReader(),
    artifacts: {
      save: (run, task, attempt) => new ArtifactStore(run.workspacePath).save(run, task, attempt),
      saveState: (run, task) => new ArtifactStore(run.workspacePath).saveState(run, task)
    },
    pr: new GhPrClient(),
    save,
    notify: (run) => orca.panels.post('run.changed', { run: json(run) }),
    log: (text) => orca.log(text)
  }
  const coordinator = new Coordinator(coordinatorDeps)
  let planSave = Promise.resolve()
  const planner = new Planner({ client, notify: (plan) => {
    const snapshot = json(planner.list())
    planSave = planSave.then(() => storage.set('pipeline.plans.v1', snapshot)).catch(error => orca.log(`Plan save: ${message(error)}`))
    if (plan.status === 'done' && plan.outputPath && plan.source) {
      void writeFile(plan.outputPath, `# agent-pipeline-workspace: ${JSON.stringify(plan.workspaceId)}\n${plan.source}`).catch(error => orca.log(`Plan document: ${message(error)}`))
    }
    orca.panels.post('plan.changed', { plan: json(plan) })
  } })

  const startPolling = (intervalMs: number) => {
    if (pollingTimer) clearInterval(pollingTimer)
    pollingTimer = setInterval(() => {
      if (!recovering) for (const run of coordinator.list()) {
        if (isBlocked(run.id)) continue
        if (run.status === 'running' || run.status === 'paused' || run.status === 'failed' && Object.values(run.tasks).some(task => task.attempts.at(-1)?.status === 'running')) void coordinator.tick(run.id)
      }
      for (const plan of planner.list()) void planner.tick(plan.id)
      void terminalBridge.poll().then(runs => { for (const run of runs) orca.panels.post('run.changed', { run: json(run) }) }).catch(error => orca.log(`Terminal pipeline: ${message(error)}`))
    }, Math.max(500, Math.min(60_000, intervalMs)))
    pollingTimer.unref()
  }

  const workspaces = async (): Promise<Workspace[]> => {
    const result = await orca.host.call('workspace.list')
    return result.workspaces
  }

  const dashboard = async (workspaceId?: string, selectedRunId?: string): Promise<Dashboard> => {
    const available = await workspaces()
    const selected = available.find((workspace) => workspace.id === workspaceId) ?? available[0]
    let beads: Bead[] = []
    let beadsError: string | undefined
    if (selected && beadsEnabled) {
      try {
        beads = await beadsFor(selected.path).list()
      } catch (error) {
        beadsError = message(error)
      }
    }
    const ownRuns = coordinator.list()
    const discovered = await Promise.allSettled(available.map(workspace => terminalBridge.discover(workspace)))
    const terminalRuns = discovered.flatMap(result => {
      if (result.status === 'fulfilled') return result.value
      orca.log(`Terminal pipeline: ${message(result.reason)}`)
      return []
    })
    if (selectedRunId && ![...ownRuns, ...terminalRuns].some(run => run.id === selectedRunId)) {
      for (const workspace of available) {
        const pinned = await terminalBridge.lookup(workspace, selectedRunId)
        if (pinned) { terminalRuns.push(pinned); break }
      }
    }
    const runHistory = [...new Map([...ownRuns, ...terminalRuns].map(run => [run.id, run])).values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const visibleRuns = runHistory.filter(run => !selected || run.workspaceId === selected.id || run.sourceWorkspaceId === selected.id)
    const agents = await discoverAgents(() => orca.host.call('agents.list'), () => client.call(['account', 'list'], 5000))
    const [projects, repos] = await Promise.all([client.call(['project', 'list']).catch(() => ({})), client.call(['repo', 'list']).catch(() => ({}))])
    return json({ ...readModelCatalog(), projects: projectOptions(projects, repos, available), agents, plans: planner.list().filter(plan => !plan.workspaceId || plan.workspaceId === selected?.id), runs: visibleRuns, runHistory, beads, beadsError, beadsEnabled, recoveryWarning, recoveryRunIds: affectedRuns ? [...affectedRuns] : undefined, workspaces: available, metrics: metricsForRuns(visibleRuns) })
  }

  orca.panels.handle('dashboard.get', async ({ workspaceId, selectedRunId }) => {
    await initialize(true)
    return dashboard(workspaceId, selectedRunId)
  })
  orca.panels.handle('history.list', async query => {
    await initialize(true)
    const limit = 25
    const own = coordinator.list().map(run => ({ id: run.id, name: run.scenario.name, createdAt: run.createdAt,
      status: run.status, workspaceId: run.sourceWorkspaceId ?? run.workspaceId, controller: 'plugin' as const }))
      .filter(run => (!query.workspaceId || run.workspaceId === query.workspaceId) && (!query.status || run.status === query.status)
        && (!query.search || (run.name + ' ' + run.id).toLowerCase().includes(query.search.toLowerCase()))
        && (!query.before || run.createdAt < query.before.createdAt || run.createdAt === query.before.createdAt && run.id < query.before.id))
    const projects = (await workspaces()).filter(workspace => !query.workspaceId || workspace.id === query.workspaceId)
    const pages = await Promise.all(projects.map(workspace => terminalBridge.page(workspace, query, limit + 1)))
    const unique = [...new Map([...pages.flat(), ...own].map(row => [row.id, row])).values()]
    unique.sort((a,b) => a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)
    return { rows: unique.slice(0, limit), more: unique.length > limit }
  })
  orca.panels.handle('history.open', async ({ workspaceId, id }) => {
    await initialize(true)
    const own = coordinator.list().find(run => run.id === id && (run.sourceWorkspaceId ?? run.workspaceId) === workspaceId)
    const workspace = (await workspaces()).find(item => item.id === workspaceId)
    const run = own ?? (workspace && await terminalBridge.lookup(workspace, id))
    if (!run) throw new Error('Run no longer available in this project')
    return { run: json(run) }
  })
  async function fileWorkspace(id: string): Promise<Workspace> {
    const workspace = (await workspaces()).find(item => item.id === id)
    if (!workspace) throw new Error('Select an available workspace.')
    return workspace
  }

  orca.panels.handle('scenario.files', async ({ workspaceId }) => ({ names: await listScenarios(await fileWorkspace(workspaceId)) }))
  orca.panels.handle('scenario.open', async ({ workspaceId, name }) => ({ source: await openScenario(await fileWorkspace(workspaceId), name) }))
  orca.panels.handle('scenario.save', async ({ workspaceId, name, source, previous }) => {
    await saveScenario(await fileWorkspace(workspaceId), name, source, previous)
    return { saved: true }
  })
  orca.panels.handle('scenario.validate', async ({ source }) => json({ scenario: parseScenario(source) }))
  orca.panels.handle('beads.action', async ({ workspaceId, id, action }) => {
    await initialize()
    if (!beadsEnabled) throw new Error('Интеграция Beads выключена. Задачи pipeline доступны без неё.')
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace не найден')
    const beads = beadsFor(workspace.path)
    if (action === 'claim') await beads.claim(id)
    else if (action === 'close') await beads.close(id, 'Закрыто из Agent Pipeline')
    else await beads.reopen(id)
    return dashboard(workspaceId)
  })

  orca.panels.handle('plan.list', async ({ workspaceId }) => {
    await initialize(true)
    return json({ plans: planner.list().filter(plan => !workspaceId || plan.workspaceId === workspaceId) })
  })
  const openEditor = async (workspace: Workspace, source: string) => {
    if (workspace.hostId && workspace.hostId !== 'local') throw new Error('Редактор планов пока открывает локальные проекты')
    const directory = join(workspace.path, '.agent-pipeline', 'plans')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${randomUUID()}.pipeline.yaml`)
    await writeFile(path, `# agent-pipeline-workspace: ${JSON.stringify(workspace.id)}\n${source}`, { flag: 'wx' })
    await orca.host.call('workspace.open', { workspaceId: workspace.id })
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: relative(workspace.path, path) })
    return path
  }
  orca.panels.handle('editor.open', async ({ workspaceId, source }) => {
    const workspace = (await workspaces()).find(item => item.id === workspaceId)
    if (!workspace) throw new Error('Выберите проект')
    parseScenario(source)
    return { path: await openEditor(workspace, source) }
  })
  orca.panels.handle('editor.publish', async ({ source, workspaceId }) => {
    parseScenario(source)
    if (!workspaceId || !(await workspaces()).some(item => item.id === workspaceId)) throw new Error('Откройте редактор из проекта в Agent Pipeline')
    orca.panels.post('scenario.changed', { source, workspaceId })
    return { ok: true as const }
  })
  orca.panels.handle('plan.start', async ({ workspaceId, objective, agent, model, effort }) => {
    await initialize()
    if (!objective.trim()) throw new Error('Опишите задачу для planner')
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Выберите проект')
    const outputPath = await openEditor(workspace, '# Planner составляет сценарий. После завершения здесь появится YAML.\n')
    const { terminalId } = await orca.host.call('terminal.create', { workspaceId, title: 'Pipeline planner' })
    const plan = await planner.start(workspace, terminalId, objective, agent, { outputPath, model, effort })
    await orca.host.call('workspace.open', { workspaceId }).catch(error => orca.log(`Open planner workspace: ${message(error)}`))
    await client.openWorker(plan.dispatchId).catch(error => orca.log(`Focus planner: ${message(error)}`))
    return json({ plan })
  })
  orca.panels.handle('plan.open', async ({ id }) => {
    await initialize(true)
    const plan = planner.get(id)
    const workspace = (await workspaces()).find(item => item.id === plan.workspaceId)
    if (!workspace || !plan.outputPath) throw new Error('У этого старого плана нет отдельного документа. Откройте текущий сценарий кнопкой редактора.')
    await orca.host.call('workspace.open', { workspaceId: workspace.id })
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: relative(workspace.path, plan.outputPath) })
    return { opened: true as const }
  })
  orca.panels.handle('plan.get', async ({ id }) => {
    await planner.tick(id)
    return json({ plan: planner.get(id) })
  })

  orca.panels.handle('run.start', async ({ workspaceId, source, separateWorkspace }) => {
    await initialize()
    const scenario = parseScenario(source)
    const sourceWorkspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!sourceWorkspace) throw new Error('Выберите доступный workspace')
    if (separateWorkspace && workspaceRestrictionConflicts(scenario, sourceWorkspace.path).length) throw new Error(`В заданиях разрешена работа только в ${sourceWorkspace.path}. Выберите «Работать в указанной папке» или измените ограничения перед созданием отдельного workspace.`)
    const workspace = separateWorkspace ? await client.createPipelineWorkspace(sourceWorkspace, scenario.name) : sourceWorkspace
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: workspace.id,
      title: `Pipeline: ${scenario.name}`
    })
    const run = await coordinator.start(workspace, terminalId, scenario, { visibleWorkers: true, sourceWorkspaceId: sourceWorkspace.id })
    await orca.host.call('workspace.open', { workspaceId: workspace.id }).catch(error => orca.log(`Open workspace: ${message(error)}`))
    return json({ run })
  })
  orca.panels.handle('run.open', async ({ id, dispatchId }) => {
    await initialize(true)
    const run = coordinator.list().find(run => run.id === id) ?? terminalBridge.get(id)
    if (!run) throw new Error(`Запуск ${id} не найден`)
    if (dispatchId) {
      const task = Object.values(run.tasks).find(task => task.attempts.some(attempt => attempt.dispatchId === dispatchId) || task.history?.some(revision => revision.attempts.some(attempt => attempt.dispatchId === dispatchId)) || task.startup?.dispatchId === dispatchId)
      if (!task) throw new Error('Попытка не принадлежит этому запуску')
      const step = run.scenario.steps.find(step => step.id === task.stepId)
      await client.openWorker(dispatchId, step?.placement.host)
    } else {
      await orca.host.call('workspace.open', { workspaceId: run.workspaceId })
    }
    return { opened: true as const }
  })
  orca.panels.handle('run.assign-agent', async ({ id, stepId, agent }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'assign', { stepId, agent }) })
    await coordinator.assignAgent(id, stepId, agent)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.apply-agents', async ({ id, source }) => {
    await initialize(false, id)
    await coordinator.applyAgentRouting(id, parseScenario(source))
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.message', async ({ id, stepId, messageId, text, questionId }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json(await terminalBridge.message(id, stepId, { id: messageId, text, questionId }))
    const run = coordinator.get(id)
    const receipt = await client.answerQuestion(run, stepId, { id: messageId, text, questionId })
    await coordinator.observeActiveWorkers(id)
    return json({ run: coordinator.get(id), receipt })
  })
  orca.panels.handle('run.recover', async ({ id, stepId }) => {
    await initialize(false, id)
    if (!terminalBridge.get(id)) throw new Error('Восстановление Pi-контекста доступно для консольных запусков')
    return json({ run: await terminalBridge.control(id, 'recover', { stepId }) })
  })
  let repairJob: { id: string; promise: Promise<{ dashboard: Dashboard; report: RecoveryReport }> } | undefined
  orca.panels.handle('run.repair', async ({ id }) => {
    await initialize(true)
    if (repairJob) {
      if (repairJob.id !== id) throw new Error('Сейчас восстанавливается другой прогон. Дождитесь результата.')
      return repairJob.promise
    }
    const operation = async () => {
      const report: RecoveryReport = { runId: id, status: 'checking', messages: ['Проверяю журнал запуска и фактических исполнителей.'], updatedAt: new Date().toISOString() }
      const publish = async () => {
        report.updatedAt = new Date().toISOString()
        await storage.set('pipeline.recovery.v1', json(report))
        orca.panels.post('recovery.changed', { report: json(report) })
      }
      await publish()
      recovering = true
      try {
        if (terminalBridge.get(id)) {
          let run = await terminalBridge.control(id, 'status')
          if (run.status === 'paused') run = await terminalBridge.control(id, 'resume')
          else if (run.status === 'failed') run = await terminalBridge.control(id, 'retry')
          report.status = run.status === 'done' ? 'complete' : run.status === 'running' ? 'continued' : 'blocked'
          report.messages.push(`Консольный прогон: ${run.status}.`)
        } else {
          const run = coordinator.get(id)
          if (['done', 'cancelled'].includes(run.status)) {
            report.status = run.status === 'done' ? 'complete' : 'blocked'
            report.messages.push(run.status === 'done' ? 'Прогон уже завершён.' : 'Прогон отменён. Для нового выполнения создайте новый прогон.')
          } else {
            const scope = await client.pendingScope(coordinator.list())
            if (scope.ambiguous) throw new Error(`Операция ${scope.ambiguous} не сопоставлена единственной сохранённой задаче.`)
            if (run.status === 'running') await coordinator.pause(id)
            report.messages.push(...await client.repairPendingLaunches(coordinator.list(), id))
            await storage.set(RUNS_KEY, json(coordinator.list()))
            if (Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks)) await client.reconcile(run)
            for (const step of run.scenario.steps) {
              const task = run.tasks[step.id]
              if (!task || task.status !== 'failed') continue
              const disabled = /Agent ([\w.-]+) is disabled/i.exec(task.error ?? '')?.[1]
              const replacement = disabled ? step.fallback.find(agent => agent !== disabled) : undefined
              if (replacement) {
                run.status = 'failed'
                await coordinator.queueRecoveryAgent(id, step.id, replacement)
                report.messages.push(`${step.title}: ${disabled} выключен; использую резервного ${replacement}.`)
              }
            }
            await publish()
            // An existing live worker is observed, never retried alongside a second one.
            if (Object.values(run.tasks).some(task => task.attempts.at(-1)?.status === 'running')) {
              await coordinator.observeActiveWorkers(id)
              if (run.status !== 'paused') { run.status = 'paused'; await save(run) }
              await coordinator.resume(id)
            } else if (Object.values(run.tasks).some(task => task.status === 'failed')) {
              run.status = 'failed'; await save(run)
              await coordinator.retry(id)
            } else await coordinator.resume(id)
            await coordinator.tick(id)
            const waiting = Object.values(run.tasks).find(task => task.unconfirmedStart || task.unconfirmedChecks || task.gateId && task.status === 'blocked' || task.questions?.some(question => question.state === 'waiting'))
            report.status = run.status === 'done' ? 'complete' : run.status === 'running' && !waiting ? 'continued' : 'blocked'
            report.messages.push(report.status === 'continued' ? 'Прогон продолжен с сохранёнными результатами завершённых шагов.' : report.status === 'complete' ? 'Прогон завершён.' : waiting?.gateId ? 'Нужно ваше решение по подтверждению шага.' : waiting?.questions?.some(question => question.state === 'waiting') ? `Агенту нужен ответ: ${waiting.questions.find(question => question.state === 'waiting')!.question}` : waiting?.error ?? run.error ?? 'Продолжение требует дополнительных данных. Откройте проблемный шаг.')
          }
        }
      } catch (error) {
        report.status = 'blocked'; report.messages.push(message(error))
      } finally {
        try {
          await storage.set(RUNS_KEY, json(coordinator.list()))
          const scope = await client.pendingScope(coordinator.list())
          affectedRuns = scope.ambiguous ? undefined : scope.affected
          if (!scope.ambiguous && !scope.affected.size) recoveryWarning = undefined
        } finally { recovering = false }
        await publish()
      }
      const selected = coordinator.list().find(run => run.id === id) ?? terminalBridge.get(id)
      return json({ dashboard: await dashboard(selected?.sourceWorkspaceId ?? selected?.workspaceId, id), report })
    }
    const promise = operation()
    repairJob = { id, promise }
    try { return await promise } finally { if (repairJob?.promise === promise) repairJob = undefined }
  })
  orca.panels.handle('run.refresh-pending-context', async ({ id, stepId }) => {
    await initialize(false, id)
    await coordinator.refreshPendingContext(id, stepId)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.exclude-invalid-steps', async ({ id, stepIds, reason }) => {
    await initialize(false, id)
    await coordinator.excludeInvalidSteps(id, stepIds, reason)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.pause', async ({ id }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'pause') })
    await coordinator.pause(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.resume', async ({ id }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'resume') })
    await coordinator.resume(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.retry', async ({ id }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'retry') })
    await coordinator.retry(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.cancel', async ({ id }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'stop') })
    await coordinator.cancel(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.tick', async ({ id }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'status') })
    await coordinator.tick(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.resolve-gate', async ({ id, stepId, resolution }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) return json({ run: await terminalBridge.control(id, 'approve', { stepId, resolution }) })
    await coordinator.resolveGate(id, stepId, resolution)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.switch-agent', async ({ id, stepId }) => {
    await initialize(false, id)
    if (terminalBridge.get(id)) throw new Error('Переключите активного исполнителя из консоли после подтверждённой остановки')
    await coordinator.switchAgent(id, stepId)
    return json({ run: coordinator.get(id) })
  })

  const applySettings = async () => {
    const settings = await orca.settings.get()
    beadsEnabled = settings.beadsEnabled === true
    coordinatorDeps.beadsFor = beadsEnabled ? beadsFor : undefined
    if (typeof settings.beadsExecutable === 'string' && settings.beadsExecutable.trim()) {
      beadsExecutable = settings.beadsExecutable
    }
    if (typeof settings.pollIntervalMs === 'number') startPolling(settings.pollIntervalMs)
  }
  orca.settings.onDidChange(({ key }) => {
    if (key === 'interfaceLanguage') return
    void applySettings().catch((error) => orca.log(`Settings: ${message(error)}`))
  })

  let initialization: Promise<void> | undefined
  const initialize = (readOnly = false, runId?: string): Promise<void> => {
    if (!initialization) initialization = (async () => {
      const plans = await storage.get('pipeline.plans.v1')
      if (Array.isArray(plans)) planner.restore(plans as PlannerRun[])
      await applySettings()
      const runs = await storedRuns(storage)
      assertRunVersions(runs)
      // Restore saved history before recovery, without binding or starting workers.
      coordinator.restore(runs, { autoResume: false })
      try {
        const { orphanedLaunches } = await client.pendingScope(runs)
        if (orphanedLaunches.size) orca.log(`Unattached launch receipts retained in the journal: ${[...orphanedLaunches].join(', ')}`)
        await client.recoverPending(entry => !orphanedLaunches.has(entry.requestId))
        recoveryWarning = undefined
        coordinator.restore(runs)
      } catch (error) {
        recoveryWarning = message(error)
        const scope = await client.pendingScope(runs)
        if (!scope.ambiguous && scope.affected.size) {
          affectedRuns = scope.affected
          coordinator.restore(runs.filter(run => !scope.affected.has(run.id)))
        }
        orca.log(`History restored; native recovery pending: ${recoveryWarning}`)
      } finally { recovering = false }
    })().catch(error => { initialization = undefined; throw error })
    return initialization.then(() => {
      if (!readOnly && repairJob) throw new Error('Дождитесь завершения диагностики прогона.')
      if (!readOnly && isBlocked(runId)) throw new Error(recoveryWarning)
    })
  }
  void initialize(true).catch(error => orca.log(`Worker init: ${message(error)}`))

}

export function deactivate(): void {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = undefined
}
