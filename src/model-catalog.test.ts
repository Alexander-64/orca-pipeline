import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseModelCatalog, readModelCatalog, modelCatalogPath } from './model-catalog'
import { parseScenario, serializeScenario } from './scenario'
import { stepForAgent } from '../packages/core/agent-preferences'

test('catalog uses one latest observed account snapshot and only observed model efforts', () => {
  const catalog = parseModelCatalog([
    { agent: 'codex', discovered: { at: 1, origin: 'probe', models: [{ id: 'old-only', efforts: [{ value: 'low' }] }] } },
    { agent: 'codex', discovered: { at: 2, origin: 'probe', models: [{ id: 'current', label: 'Current', efforts: [{ value: 'high', label: 'High' }] }, { id: 'unknown-effort', effortsKnown: false, efforts: [{ value: 'max' }] }] } },
    { agent: 'codex', discovered: { at: 3, origin: 'seed', models: [{ id: 'invented' }] } },
    { agent: 'codex', live: { at: 4, origin: 'live-session', complete: false, models: [{ id: 'unfinished' }] } }
  ])
  assert.deepEqual(catalog.codex.models.map(model => model.id), ['current', 'unknown-effort'])
  assert.deepEqual(catalog.codex.models[0].efforts, [{ value: 'high', label: 'High' }])
  assert.deepEqual(catalog.codex.models[1].efforts, [])
})

test('model preferences survive YAML and use the selected agent for fallback and generated review', () => {
  const scenario = parseScenario(`name: models
objective: Models per agent
steps:
 - id: work
   title: Work
   spec: Work
   agent: codex
   model: main-model
   effort: high
   fallback: [claude, kimi]
   reviewAgent: claude
   agentPreferences:
     claude: {model: reviewer-model, effort: medium}
   acceptance: [pwd]
`, { expandEvidence: false })
  const restored = parseScenario(serializeScenario(scenario), { expandEvidence: false })
  assert.equal(stepForAgent(restored.steps[0], 'codex').model, 'main-model')
  assert.equal(stepForAgent(restored.steps[0], 'claude').model, 'reviewer-model')
  assert.equal(stepForAgent(restored.steps[0], 'claude').effort, 'medium')
  assert.equal(stepForAgent(restored.steps[0], 'kimi').model, undefined)
  assert.equal(stepForAgent(restored.steps[0], 'kimi').effort, undefined)
  const expanded = parseScenario(serializeScenario(restored))
  const review = expanded.steps.find(step => step.role === 'evidence')!
  assert.equal(review.agent, 'claude'); assert.equal(review.model, 'reviewer-model')
  assert.equal(review.effort, 'medium'); assert.deepEqual(review.needs, ['work'])
  assert.throws(() => parseScenario(serializeScenario(scenario).replace('model: reviewer-model', '')), /effort требует model/)
})

test('coordinator launches a reserve agent with its own model instead of the primary model', async () => {
  const { coordinatorFixture, fixtureWorkspace } = await import('./coordinatorFixture')
  const h = coordinatorFixture()
  const observed: { agent: string; model?: string; effort?: string }[] = []
  const original = h.client.startWorker
  h.client.startWorker = async (...args) => {
    observed.push({ agent: args[3], model: args[1].model, effort: args[1].effort })
    return original(...args)
  }
  const scenario = parseScenario(`name: fallback-models
objective: Fallback models
steps:
 - {id: work, title: Work, spec: Work, agent: codex, model: model-main, effort: high, fallback: [claude], agentPreferences: {claude: {model: model-reserve, effort: medium}}, acceptance: [pwd]}
`)
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', scenario)
  h.statuses.set('task_work', 'failed')
  await h.coordinator.tick(run.id)
  assert.deepEqual(observed, [
    { agent: 'codex', model: 'model-main', effort: 'high' },
    { agent: 'claude', model: 'model-reserve', effort: 'medium' }
  ])
})

test('recovery uses the requested configured reserve without changing the saved scenario', async () => {
  const { coordinatorFixture, fixtureWorkspace } = await import('./coordinatorFixture')
  const h = coordinatorFixture()
  const scenario = parseScenario(`name: recovery-agent
objective: Recovery
steps:
 - {id: work, title: Work, spec: Work, agent: codex, fallback: [kimi, claude], acceptance: [pwd]}
`)
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', scenario)
  run.tasks.work.attempts[0].status = 'failed'; run.tasks.work.status = 'failed'; run.status = 'failed'
  h.statuses.set('task_work', 'failed')
  await h.coordinator.queueRecoveryAgent(run.id, 'work', 'claude')
  await h.coordinator.retry(run.id)
  assert.deepEqual(h.starts.map(start => start.agent), ['codex', 'claude'])
  assert.equal(run.scenario.steps[0].agent, 'codex')
  assert.deepEqual(run.scenario.steps[0].fallback, ['kimi', 'claude'])
  assert.equal(run.tasks.work.recoveryAgent, undefined)
})

test('catalog distinguishes an absent cache, incompatible schema or adapter, and per-agent defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-catalog-')), file = join(dir, 'models.db')
  try {
    assert.equal(readModelCatalog(file).modelCatalogState, 'undiscovered')
    const db = new DatabaseSync(file)
    try {
      assert.equal(readModelCatalog(file).modelCatalogState, 'unsupported')
      db.exec('CREATE TABLE rows(seq INTEGER, value TEXT)')
      assert.equal(readModelCatalog(file, () => undefined).modelCatalogState, 'unsupported')
      for (const agent of ['codex','pi']) db.prepare('INSERT INTO rows VALUES(1,?)').run(JSON.stringify({ agent,
        live: { origin: 'live-session', at: 100, models: [{ id:'sample', efforts: [{value:'low'}, {value:'high'}] }] } }))
      const state = readModelCatalog(file, () => agent => ({ supportsWorkerLaunchPreferences: agent === 'codex',
        models: [{id:'sample', options:[{id:'effort',kind:{type:'select',choices:[{value:'high'}]}}]}] }))
      assert.equal(state.modelCatalogState, 'ready')
      assert.deepEqual(state.unsupportedModelAgents, ['pi'])
      assert.deepEqual(state.modelCatalogs.codex.models[0].efforts.map(e => e.value), ['high'])
    } finally { db.close() }
  } finally { await rm(dir, { recursive:true, force:true }) }
})


test('the selected Orca profile owns the discovery cache', () => {
  assert.equal(modelCatalogPath('darwin', { ORCA_USER_DATA_PATH: '/fixture/profile', ORCA_USER_DATA: '/fixture/other' }), '/fixture/profile/agent-model-catalog.db')
  assert.equal(modelCatalogPath('darwin', { ORCA_USER_DATA: '/fixture/runtime' }), '/fixture/runtime/agent-model-catalog.db')
})
