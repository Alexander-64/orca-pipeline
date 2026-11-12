import { assert, mockHost, mount, test } from 'orca/testing'
import { metricsForRuns } from './metrics'
import * as panel from './panel'
import { demoDashboard, demoRun } from './testData'

test('aggregates attempts, failovers, duration and agent outcomes', () => {
  const run = structuredClone(demoRun)
  run.updatedAt = '2026-11-10T12:05:00.000Z'
  run.tasks.build.status = 'done'
  run.tasks.build.attempts.push({
    dispatchId: 'dispatch_2',
    agent: 'claude',
    status: 'done',
    startedAt: '2026-11-10T12:01:00.000Z',
    finishedAt: '2026-11-10T12:02:00.000Z'
  })
  const metrics = metricsForRuns([run])
  assert.equal(metrics.attempts, 2)
  assert.equal(metrics.failovers, 1)
  assert.equal(metrics.completedSteps, 1)
  assert.equal(metrics.successRate, 100)
  assert.equal(metrics.durationMs, 300_000)
  assert.deepEqual(metrics.byAgent.map((row) => row.agent), ['claude', 'codex'])
})

test('returns zero rates and duration without completed work', () => {
  const metrics = metricsForRuns([])
  assert.equal(metrics.successRate, 0)
  assert.equal(metrics.durationMs, 0)
  assert.deepEqual(metrics.byAgent, [])
})

test('uses the latest update for an active run duration', () => {
  const run = structuredClone(demoRun)
  run.updatedAt = '2026-11-10T12:10:00.000Z'
  assert.equal(metricsForRuns([run]).durationMs, 600_000)
})

test('renders agent metrics and run timeline', async () => {
  const host = mockHost({
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun], metrics: metricsForRuns([demoRun]) }) }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'metrics' } } })
  assert.deepEqual(view.rowsOf({ label: 'По агентам' }), ['codex'])
  assert.ok(view.find({ text: /demo-pipeline/ }))
  await view.unmount()
})
