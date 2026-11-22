import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard } from './testData'
import { DEFAULT_SCENARIO, type PlannerRun } from './types'
import { parseScenario } from './scenario'

const completed: PlannerRun = { id: 'latest', runId: 'run-latest', dispatchId: 'dispatch', agent: 'custom-agent', objective: 'Generate a plan', workspaceId: 'workspace-1', status: 'done', source: DEFAULT_SCENARIO.replace('demo-pipeline', 'generated') }
const host = () => mockHost({ requests: { 'dashboard.get': () => ({ ...demoDashboard, plans: [completed], agents: [{ id: 'custom-agent', label: 'Custom agent' }] }) } })

test('restores latest planner, summary, graph and selection; replay preserves manual edits', async () => {
  const view = await mount(panel, { host: host() })
  assert.match(String(view.valueOf({ label: 'YAML scenario' })), /generated/)
  assert.equal(view.valueOf({ label: 'Scenario name' }), 'generated')
  assert.equal(view.valueOf({ label: 'Step title' }), 'Implementation')
  assert.match(JSON.stringify(view.tree()), /run-latest/)
  assert.match(JSON.stringify(view.tree()), /Generate a plan/)
  assert.match(JSON.stringify(view.tree()), /Waves/)
  await view.type({ label: 'Scenario name' }, 'manual', { replace: true })
  await view.press({ text: 'Apply name and objective' })
  await view.post('plan.changed', { plan: completed })
  await view.press({ text: 'Refresh' })
  assert.equal(view.valueOf({ label: 'Scenario name' }), 'manual')
  const persisted = view.persisted
  await view.unmount()
  const reopened = await mount(panel, { host: host(), persisted })
  assert.equal(reopened.valueOf({ label: 'Scenario name' }), 'manual')
  assert.deepEqual(reopened.errors, [])
  await reopened.unmount()
})

test('switches persisted editor modes and selects discovered fallback', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'Editor view' }, 'map')
  assert.equal(view.find({ label: 'YAML scenario' }), null)
  await view.toggle({ label: 'Fallback implement: Custom agent' })
  await view.press({ text: 'Apply step' })
  await view.select({ label: 'Editor view' }, 'yaml')
  assert.equal(view.find({ text: 'DAG editor' }), null)
  assert.ok(parseScenario(String(view.valueOf({ label: 'YAML scenario' }))).steps[0].fallback.includes('custom-agent'))
  await view.select({ label: 'Editor view' }, 'split')
  assert.ok(view.find({ text: 'DAG editor' }))
  assert.ok(view.find({ label: 'YAML scenario' }))
  assert.equal(view.persisted.plugin['pipeline.editor-view'], 'split')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('invalid planner source cannot partially replace editor; metadata is validated', async () => {
  const view = await mount(panel, { host: host() })
  const original = view.valueOf({ label: 'YAML scenario' })
  await view.post('plan.changed', { plan: { ...completed, id: 'invalid', source: 'steps: [' } })
  assert.equal(view.valueOf({ label: 'YAML scenario' }), original)
  await view.type({ label: 'Scenario name' }, '', { replace: true })
  await view.press({ text: 'Apply name and objective' })
  assert.equal(view.valueOf({ label: 'YAML scenario' }), original)
  await view.unmount()
})
