import type { OrcaWorkerApi } from 'orca/worker'
import { ArtifactStore } from './artifacts'
import { BeadsClient } from './beads'
import { OrcaClient } from './cli'
import { Coordinator } from './coordinator'
import { discoverAgents } from './agents'
import { Planner } from './planner'
import { metricsForRuns } from './metrics'
import { GhPrClient } from './pr'
import { StorageMutationJournal } from './mutations'
import { parseScenario } from './scenario'
import { CodexUsageReader } from './usage'
import type { Bead, Dashboard, PipelineRun, PlannerRun, Workspace } from './types'

const RUNS_KEY = 'pipeline.runs.v1'
let pollingTimer: ReturnType<typeof setInterval> | undefined

async function storedRuns(orca: OrcaWorkerApi): Promise<PipelineRun[]> {
  const value = await orca.storage.get(RUNS_KEY)
  return Array.isArray(value) ? value as PipelineRun[] : []
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export default function activate(orca: OrcaWorkerApi): void {
  let beadsExecutable = 'bd'
  const client = new OrcaClient(undefined, undefined, new StorageMutationJournal(orca.storage))
  const beadsFor = (workspacePath: string) => new BeadsClient(workspacePath, undefined, beadsExecutable)
  const save = async (run: PipelineRun) => {
    const runs = coordinator.list().map((candidate) => candidate.id === run.id ? run : candidate)
    await orca.storage.set(RUNS_KEY, json(runs))
  }
  const coordinator = new Coordinator({
    client,
    beadsFor,
    usage: new CodexUsageReader(),
    artifacts: {
      save: (run, task, attempt) => new ArtifactStore(run.workspacePath).save(run, task, attempt)
    },
    pr: new GhPrClient(),
    save,
    notify: (run) => orca.panels.post('run.changed', { run: json(run) }),
    log: (text) => orca.log(text)
  })
  let planSave = Promise.resolve()
  const planner = new Planner({ client, notify: (plan) => {
    const snapshot = json(planner.list())
    planSave = planSave.then(() => orca.storage.set('pipeline.plans.v1', snapshot)).catch(error => orca.log(`Plan save: ${message(error)}`))
    orca.panels.post('plan.changed', { plan: json(plan) })
  } })

  const startPolling = (intervalMs: number) => {
    if (pollingTimer) clearInterval(pollingTimer)
    pollingTimer = setInterval(() => {
      for (const run of coordinator.list()) {
        if (run.status === 'running' || run.status === 'paused') void coordinator.tick(run.id)
      }
      for (const plan of planner.list()) void planner.tick(plan.id)
    }, Math.max(500, Math.min(60_000, intervalMs)))
    pollingTimer.unref()
  }

  const workspaces = async (): Promise<Workspace[]> => {
    const result = await orca.host.call('workspace.list')
    return result.workspaces
  }

  const dashboard = async (workspaceId?: string): Promise<Dashboard> => {
    const available = await workspaces()
    const selected = available.find((workspace) => workspace.id === workspaceId) ?? available[0]
    let beads: Bead[] = []
    let beadsError: string | undefined
    if (selected) {
      try {
        beads = await beadsFor(selected.path).list()
      } catch (error) {
        beadsError = message(error)
      }
    }
    const agents = await discoverAgents(() => orca.host.call('agents.list'), () => client.call(['account', 'list'], 5000))
    return json({ agents, plans: planner.list().filter(plan => !plan.workspaceId || plan.workspaceId === selected?.id), runs: coordinator.list(), beads, beadsError, workspaces: available, metrics: metricsForRuns(coordinator.list()) })
  }

  orca.panels.handle('dashboard.get', async ({ workspaceId }) => {
    await initialized
    return dashboard(workspaceId)
  })
  orca.panels.handle('scenario.validate', async ({ source }) => json({ scenario: parseScenario(source) }))
  orca.panels.handle('beads.action', async ({ workspaceId, id, action }) => {
    await initialized
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace не найден')
    const beads = beadsFor(workspace.path)
    if (action === 'claim') await beads.claim(id)
    else if (action === 'close') await beads.close(id, 'Закрыто из Agent Pipeline')
    else await beads.reopen(id)
    return dashboard(workspaceId)
  })

  orca.panels.handle('plan.list', async ({ workspaceId }) => {
    await initialized
    return json({ plans: planner.list().filter(plan => !workspaceId || plan.workspaceId === workspaceId) })
  })
  orca.panels.handle('plan.start', async ({ workspaceId, objective, agent }) => {
    await initialized
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Выберите workspace')
    const { terminalId } = await orca.host.call('terminal.create', { workspaceId, title: 'Pipeline planner' })
    return json({ plan: await planner.start(workspace, terminalId, objective, agent) })
  })
  orca.panels.handle('plan.get', async ({ id }) => {
    await planner.tick(id)
    return json({ plan: planner.get(id) })
  })

  orca.panels.handle('run.start', async ({ workspaceId, source }) => {
    await initialized
    const scenario = parseScenario(source)
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Выберите доступный workspace')
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId,
      title: `Pipeline: ${scenario.name}`
    })
    return json({ run: await coordinator.start(workspace, terminalId, scenario) })
  })
  orca.panels.handle('run.pause', async ({ id }) => {
    await initialized
    await coordinator.pause(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.resume', async ({ id }) => {
    await initialized
    await coordinator.resume(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.retry', async ({ id }) => {
    await initialized
    await coordinator.retry(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.cancel', async ({ id }) => {
    await initialized
    await coordinator.cancel(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.tick', async ({ id }) => {
    await initialized
    await coordinator.tick(id)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.resolve-gate', async ({ id, stepId, resolution }) => {
    await initialized
    await coordinator.resolveGate(id, stepId, resolution)
    return json({ run: coordinator.get(id) })
  })
  orca.panels.handle('run.switch-agent', async ({ id, stepId }) => {
    await initialized
    await coordinator.switchAgent(id, stepId)
    return json({ run: coordinator.get(id) })
  })

  const applySettings = async () => {
    const settings = await orca.settings.get()
    if (typeof settings.beadsExecutable === 'string' && settings.beadsExecutable.trim()) {
      beadsExecutable = settings.beadsExecutable
    }
    if (typeof settings.pollIntervalMs === 'number') startPolling(settings.pollIntervalMs)
  }
  orca.settings.onDidChange(() => {
    void applySettings().catch((error) => orca.log(`Settings: ${message(error)}`))
  })

  const initialized = (async () => {
    const plans = await orca.storage.get('pipeline.plans.v1')
    if (Array.isArray(plans)) planner.restore(plans as PlannerRun[])
    await applySettings()
    await client.recoverPending()
    coordinator.restore(await storedRuns(orca))
  })()
  initialized.catch((error) => orca.log(`Worker init: ${message(error)}`))
}

export function deactivate(): void {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = undefined
}
