// Dedicated native UX fixture: no terminal, file-editing, account or network calls.
import { demoDashboard, demoRun, dependencyRun } from '../../src/testData'
import { DEFAULT_SCENARIO } from '../../src/types'
import { parseScenario } from '../../src/scenario'
import { metricsForRuns } from '../../src/metrics'
export default function activate(orca: any) {
  let config: any = {}, state: any, calls: any[] = [], observation: any
  const clone = (value: any) => JSON.parse(JSON.stringify(value))
  const make = () => {
    const run = clone(config.dependency ? dependencyRun : demoRun)
    if (config.done) { run.status = 'done'; for (const task of Object.values(run.tasks) as any[]) { task.status = 'done'; task.attempts = [{ dispatchId: 'fixture-dispatch', agent: task.agent, status: 'done', startedAt: run.createdAt, output: 'E2E final result' }] } }
    if (config.unknown) { run.status = 'paused'; run.tasks.build.status = 'blocked'; run.tasks.build.unconfirmedStart = true; run.tasks.build.error = 'Agent claude is disabled.' }
    if (config.question) { run.tasks.build.interaction = 'native'; run.tasks.build.questions = [{ id: 'question-e2e', state: 'waiting', question: 'Что проверить?', askedAt: run.createdAt }] }
    const old = clone(run); old.id = 'old-e2e'; old.workspaceId = 'workspace-2'; old.workspacePath = '/tmp/e2e-second'; old.scenario.name = 'history-e2e'
    const result = { ...clone(demoDashboard), runs: config.empty ? [] : [run], runHistory: config.empty ? [] : [run, old], plans: [], beads: [], beadsEnabled: !!config.beads, modelCatalogs: {
      codex: { observedAt: 1000, models: [{ id: 'e2e-model', label: 'E2E Model', efforts: [{ value: 'high', label: 'High' }] }] }
    } }
    result.workspaces.push({ id: 'workspace-2', kind: 'folder', name: 'Second project', path: '/tmp/e2e-second', branch: null, hostId: null })
    if (config.unknown) result.recoveryWarning = 'unconfirmed receipt'
    if (config.beads) result.beadsError = 'E2E bd unavailable'
    result.metrics = metricsForRuns(result.runs)
    return result
  }
  const handle = (name: string, fn: (input: any) => any) => orca.panels.handle(name, async (input: any) => { calls.push({ name, input: clone(input) }); return clone(await fn(input)) })
  orca.panels.handle('e2e.configure', (input: any) => { config = input; state = make(); calls = []; observation = null; orca.panels.post('e2e.reset', { dashboard: state, source: config.source || DEFAULT_SCENARIO, mode: config.empty ? 'new' : 'existing', stage: config.stage || 'monitor' }); return { ok: true } })
  orca.panels.handle('e2e.boot', () => ({ dashboard: state, source: config.source || DEFAULT_SCENARIO, mode: config.empty ? 'new' : 'existing', stage: config.stage || 'monitor' }))
  orca.panels.handle('e2e.observe', (input: any) => { observation = input; return { ok: true } })
  orca.panels.handle('e2e.report', () => clone({ observation, calls, dashboard: state }))
  state = make()
  handle('dashboard.get', () => state)
  handle('scenario.validate', ({ source }) => ({ scenario: parseScenario(source) }))
  handle('plan.start', () => { const plan = { id: 'plan-e2e', runId: 'plan-run-e2e', dispatchId: 'plan-dispatch-e2e', agent: 'codex', status: 'running' }; const source = config.invalidPlan ? 'steps: [' : DEFAULT_SCENARIO.replace('demo-pipeline', 'planned-e2e'); setTimeout(() => orca.panels.post('plan.changed', { plan: { ...plan, status: 'done', source } }), 50); return { plan } })
  handle('run.start', ({ source, workspaceId }) => {
    const run = clone(demoRun); run.id = 'started-e2e'; run.scenario = parseScenario(source); run.workspaceId = workspaceId
    state.runs.push(run); state.runHistory.push(run); return { run }
  })
  handle('run.repair', async () => {
    if (config.repairDelay) await new Promise(resolve => setTimeout(resolve, config.repairDelay))
    const run = state.runs[0]; run.status = 'running'; delete run.tasks.build.unconfirmedStart; delete run.tasks.build.error; delete state.recoveryWarning
    return { dashboard: state, report: { runId: run.id, status: 'continued', messages: ['E2E recovery complete'], updatedAt: run.updatedAt } }
  })
  handle('run.tick', () => {
    const run = state.runs[0]; run.tasks.build.status = config.tickFail ? 'failed' : 'done'; run.updatedAt = '2026-11-17T23:59:59Z'
    state.metrics = metricsForRuns(state.runs); orca.panels.post('run.changed', { run }); return { run }
  })
  handle('run.message', (input) => {
    if (config.messageTimeout && calls.filter(call => call.name === 'run.message').length === 1) throw new Error('E2E timeout: receipt unknown')
    state.runs[0].tasks.build.questions[0].state = 'answered'
    return { run: state.runs[0], receipt: { id: input.messageId, state: 'queued', at: state.runs[0].updatedAt } }
  })
}
