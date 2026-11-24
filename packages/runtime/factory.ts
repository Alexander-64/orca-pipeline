import { LocalBackend } from './backend'
import { OrcaBackend } from './orca-backend'
import type { RuntimeConfig } from './config'
import type { RunStore } from './store'
import type { ExecutionBackend } from '../core/contracts'
import type { PipelineRun, Scenario, ScenarioStep } from '../core/types'
import type { UserMessage } from '../core/types'

export class RoutingBackend implements ExecutionBackend {
  readonly local: LocalBackend
  readonly orca: OrcaBackend
  mode: 'local' | 'orca'
  constructor(readonly store: RunStore, project: string, config: RuntimeConfig) {
    this.local = new LocalBackend(store, project, config); this.orca = new OrcaBackend(store, project, config); this.mode = config.backend ?? 'local'
  }
  set creationRequestId(id: string | undefined) { this.local.creationRequestId = id; this.orca.creationRequestId = id }
  private selected() { return this.mode === 'orca' ? this.orca : this.local }
  private run(id: string): LocalBackend | OrcaBackend { return this.store.get<{ backend?: string }>('native-run:' + id)?.backend === 'orca' ? this.orca : this.local }
  private dispatch(id: string): LocalBackend | OrcaBackend {
    if (this.store.get('orca-dispatch:' + id)) return this.orca
    if (this.store.get('attempt:' + id)) return this.local
    const startupRun = this.store.list<PipelineRun>('run:').find(run => Object.values(run.tasks).some(task => task.startup?.dispatchId === id))
    if (startupRun) return this.run(startupRun.runId)
    throw new Error('Unknown dispatch receipt: ' + id)
  }
  preflightScenario(scenario: Scenario) { return this.selected().preflightScenario(scenario) }
  createRun(objective: string, owner: string) { return this.selected().createRun(objective, owner) }
  bindRun(id: string, owner: string) { return this.run(id).bindRun(id, owner) }
  reconcile(run: PipelineRun) { return this.run(run.runId).reconcile(run) }
  createTask(id: string, owner: string, step: ScenarioStep, spec: string, deps: string[]) { return this.run(id).createTask(id, owner, step, spec, deps) }
  reviseTask(run: PipelineRun, step: ScenarioStep, revision: number, spec: string, deps: string[]) { return this.run(run.runId).reviseTask(run, step, revision, spec, deps) }
  prepareRetry(run: PipelineRun, step: ScenarioStep, task: PipelineRun['tasks'][string]) { const backend = this.run(run.runId); return backend instanceof OrcaBackend ? backend.prepareRetry(run, step, task) : Promise.resolve(undefined) }
  listTasks(id: string) { return this.run(id).listTasks(id) }
  skipTask(id: string, owner: string, task: string, reason: string) { return this.run(id).skipTask(id, owner, task, reason) }
  canStart(run: PipelineRun, step: ScenarioStep, agent: string) {
    const others = this.store.list<PipelineRun>('run:').filter(candidate => candidate.id !== run.id)
    const active = [...others, run].filter(candidate => Object.values(candidate.tasks).some(task => task.unconfirmedStart || task.attempts.at(-1)?.status === 'running'))
    if (active.length && (!run.scenario.commandPolicy?.readOnly || active.some(candidate => !candidate.scenario.commandPolicy?.readOnly))) return false
    const backend = this.run(run.runId)
    return backend instanceof LocalBackend ? backend.canStart(run, step, agent) : backend.canStart(run, step, agent)
  }
  startWorker(run: PipelineRun, step: ScenarioStep, task: string, agent: string, retry?: string, terminal?: string) {
    const backend = this.run(run.runId)
    return backend instanceof OrcaBackend ? backend.startWorker(run, step, task, agent, retry, terminal) : backend.startWorker(run, step, task, agent, retry)
  }
  workerOutput(id: string) { return this.dispatch(id).workerOutput(id) }
  prepareCheckpoint(run: PipelineRun, step: ScenarioStep, task: string, body: string) { return this.run(run.runId).prepareCheckpoint(run, step, task, body) }
  workerActivityDone(id: string) { return this.dispatch(id).workerActivityDone(id) }
  workerFailure(id: string) { return this.dispatch(id).workerFailure(id) }
  settledResult(id: string) { return this.dispatch(id).settledResult(id) }
  requestStop(run: PipelineRun) { const backend = this.run(run.runId); return backend instanceof OrcaBackend ? backend.requestStop(run.runId) : Promise.resolve() }
  workerObservation(id: string) { return this.dispatch(id).workerObservation(id) }
  observationIntervalMs(id: string): number { return this.dispatch(id) instanceof LocalBackend ? 1000 : 10000 }
  sendUserMessage(id: string, message: UserMessage) {
    const backend = this.dispatch(id)
    if (!(backend instanceof LocalBackend)) throw new Error('Use the native Orca window to message this executor')
    return backend.sendUserMessage(id, message)
  }
  recoverPi(id: string) {
    const backend = this.dispatch(id)
    if (!(backend instanceof LocalBackend)) throw new Error('Use native Orca reconciliation for this executor')
    return backend.recoverPi(id)
  }
  stopWorker(id: string) { return this.dispatch(id).stopWorker(id) }
  releaseWorker(id: string) { return this.dispatch(id).releaseWorker(id) }
  async openWorker(id: string) { const backend = this.dispatch(id); if (!(backend instanceof OrcaBackend)) throw new Error('Local worker has no Orca window; use the report view'); await backend.openWorker(id) }
  sendWorker(id: string, subject: string, body: string, _owner: string) { return this.dispatch(id).sendWorker(id, subject, body) }
  failedStartup(run: string, task: string) { return this.run(run).failedStartup(run, task) }
  createGate(run: string, owner: string, task: string, question: string) { return this.run(run).createGate(run, owner, task, question) }
  listGates(run: string, task: string) { return this.run(run).listGates(run, task) }
  resolveGate(id: string, owner: string, resolution: 'approve' | 'reject') {
    return (this.store.get('orca-gate:' + id) ? this.orca : this.local).resolveGate(id, owner, resolution)
  }
}

export const createBackend = (store: RunStore, project: string, config: RuntimeConfig) => new RoutingBackend(store, project, config)
