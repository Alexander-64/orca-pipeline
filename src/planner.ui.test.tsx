import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard } from './testData'
import { DEFAULT_SCENARIO, type PlannerRun } from './types'
import { parseScenario } from './scenario'

const completed: PlannerRun = { id: 'latest', runId: 'run-latest', dispatchId: 'dispatch', agent: 'custom-agent', objective: 'Generate a plan', workspaceId: 'workspace-1', status: 'done', source: DEFAULT_SCENARIO.replace('demo-pipeline', 'generated') }
const host = () => mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, plans: [completed], agents: [{ id: 'custom-agent', label: 'Custom agent' }] }) } })

test('restores latest planner, summary, graph and selection; replay preserves manual edits', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  assert.match(String(view.valueOf({ label: 'YAML-сценарий' })), /generated/)
  assert.equal(view.valueOf({ label: 'Название шага' }), 'Реализация')
  await view.select({ label: 'Этап pipeline' }, 'project')
  await view.toggle({ label: 'Название и цель · generated' })
  assert.equal(view.valueOf({ label: 'Scenario name' }), 'generated')
  await view.toggle({ label: 'Planner · custom-agent · done' })
  assert.match(JSON.stringify(view.tree()), /run-latest/)
  assert.match(JSON.stringify(view.tree()), /Generate a plan/)
  assert.match(JSON.stringify(view.tree()), /Волн/)
  await view.type({ label: 'Scenario name' }, 'manual', { replace: true })
  await view.press({ text: 'Применить название и цель' })
  await view.post('plan.changed', { plan: completed })
  await view.press({ text: 'Обновить' })
  assert.equal(view.valueOf({ label: 'Scenario name' }), 'manual')
  const persisted = view.persisted
  await view.unmount()
  const reopened = await mount(panel, { host: host(), persisted })
  await reopened.toggle({ label: 'Название и цель · manual' })
  assert.equal(reopened.valueOf({ label: 'Scenario name' }), 'manual')
  assert.deepEqual(reopened.errors, [])
  await reopened.unmount()
})

test('switches persisted editor modes and selects discovered fallback', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  await view.select({ label: 'Вид редактора' }, 'map')
  assert.equal(view.find({ label: 'YAML-сценарий' }), null)
  await view.press({ text: '+ Custom agent' })
  await view.press({ text: 'Применить шаг' })
  await view.select({ label: 'Вид редактора' }, 'yaml')
  assert.equal(view.find({ text: 'DAG-редактор' }), null)
  assert.ok(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0].fallback.includes('custom-agent'))
  await view.select({ label: 'Вид редактора' }, 'split')
  assert.ok(view.find({ text: 'DAG-редактор' }))
  assert.ok(view.find({ label: 'YAML-сценарий' }))
  assert.equal(view.persisted.plugin['pipeline.editor-view'], 'split')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('invalid planner source cannot partially replace editor; metadata is validated', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  const original = view.valueOf({ label: 'YAML-сценарий' })
  await view.post('plan.changed', { plan: { ...completed, id: 'invalid', source: 'steps: [' } })
  assert.equal(view.valueOf({ label: 'YAML-сценарий' }), original)
  await view.select({ label: 'Этап pipeline' }, 'project')
  await view.toggle({ label: 'Название и цель · generated' })
  await view.type({ label: 'Scenario name' }, '', { replace: true })
  await view.press({ text: 'Применить название и цель' })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  assert.equal(view.valueOf({ label: 'YAML-сценарий' }), original)
  await view.unmount()
})
