import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard, demoRun } from './testData'
import { parseScenario } from './scenario'
import { DEFAULT_SCENARIO, type PipelineRun } from './types'

test('loads workspaces and validates the YAML draft', async () => {
  const host = mockHost({
    requests: {
      'dashboard.get': () => demoDashboard,
      'scenario.validate': ({ source }) => ({ scenario: parseScenario(source) })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Workspace' }), 'workspace-1')
  await view.press({ text: 'Validate YAML' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('starts a run and shows its execution state', async () => {
  const host = mockHost({
    requests: {
      'dashboard.get': () => demoDashboard,
      'run.start': () => ({ run: demoRun })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Start' })
  assert.ok(view.find({ text: /demo-pipeline/ }))
  assert.ok(view.find({ text: /Implementation/ }))
  await view.select({ label: 'Agent Pipeline' }, 'beads')
  assert.deepEqual(view.rowsOf({ label: 'Beads tasks' }), ['bd-demo1'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('fills the draft when the planner returns a scenario', async () => {
  const source = DEFAULT_SCENARIO.replace('demo-pipeline', 'generated-pipeline')
  const host = mockHost({
    requests: {
      'dashboard.get': () => demoDashboard,
      'plan.start': () => ({ plan: { id: 'plan-1', runId: 'run-plan', dispatchId: 'dispatch-plan', agent: 'codex', status: 'running' } })
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ label: 'Plan a scenario with an agent' })
  await view.type({ label: 'Objective' }, 'Сделать экспорт')
  await view.press({ text: 'Generate YAML' })
  assert.ok(view.find({ text: 'Planner is running…' }))
  await view.post('plan.changed', {
    plan: { id: 'plan-1', runId: 'run-plan', dispatchId: 'dispatch-plan', agent: 'codex', status: 'done', source }
  })
  assert.match(String(view.valueOf({ label: 'YAML scenario' })), /generated-pipeline/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('retry button sends the failed run and renders the recovered state', async () => {
  const failed: PipelineRun = {
    ...demoRun,
    status: 'failed',
    tasks: {
      build: {
        ...demoRun.tasks.build,
        status: 'failed',
        attempts: [{ ...demoRun.tasks.build.attempts[0], status: 'failed', reason: 'quota' }]
      }
    }
  }
  const recovered: PipelineRun = { ...demoRun, status: 'done' }
  const host = mockHost({
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [failed] }),
      'run.retry': () => ({ run: recovered })
    }
  })
  const view = await mount(panel, {
    host,
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': failed.id } }
  })
  await view.press({ text: 'Try next fallback' })
  assert.ok(view.find({ role: 'status', text: 'done' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('validates the real default draft', () => {
  assert.equal(parseScenario(DEFAULT_SCENARIO).steps.length, 2)
})
