import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { metricsForRuns } from './metrics'
import { demoRun } from './testData'

test('validates a scenario through the worker without starting a run', async () => {
  const host = mockHost({
    results: {
      'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('scenario.validate', {
    source: 'name: test\nobjective: test\nsteps:\n  - id: one\n    title: One\n    spec: Work\n    agent: codex\n    acceptance: [test]\n'
  })
  assert.equal(answer.scenario.steps[0].id, 'one')
  const { agents, plans, ...dashboard } = await worker.request('dashboard.get', {})
  assert.ok(agents?.some(agent => agent.id === 'codex'))
  assert.deepEqual(plans, [])
  assert.deepEqual(dashboard, {
    runs: [],
    beads: [],
    workspaces: [],
    metrics: metricsForRuns([])
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('rejects an invalid scenario before touching Orca', async () => {
  const worker = await mountWorker(main)
  await assert.rejects(() => worker.request('scenario.validate', { source: 'name: broken' }), /steps/)
  await worker.deactivate()
})

test('restores persisted runs before answering the first dashboard request', async () => {
  const persisted = { ...demoRun, status: 'done' as const }
  const host = mockHost({
    storage: { 'pipeline.runs.v1': [persisted] },
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const dashboard = await worker.request('dashboard.get', {})
  assert.equal(dashboard.runs.length, 1)
  assert.equal(dashboard.runs[0].id, demoRun.id)
  assert.equal(dashboard.runs[0].status, 'done')
  await worker.deactivate()
})

 test('restores completed planner source through plan.list after worker restart', async () => {
  const saved = { id: 'saved', runId: 'run', dispatchId: 'dispatch', agent: 'codex', status: 'done', workspaceId: 'workspace-1', source: 'saved source' }
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'pipeline.plans.v1': [saved] } }) })
  assert.deepEqual((await worker.request('plan.list', { workspaceId: 'workspace-1' })).plans, [saved])
  assert.deepEqual((await worker.request('plan.list', { workspaceId: 'other' })).plans, [])
  await worker.deactivate()
})
