import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard } from './testData'
import { parseScenario } from './scenario'

function hostWithValidation() {
  return mockHost({
    requests: {
      'dashboard.get': () => demoDashboard,
      'scenario.validate': ({ source }) => JSON.parse(JSON.stringify({ scenario: parseScenario(source) }))
    }
  })
}

test('applies a workflow template to the YAML draft', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Шаблон' }, 'bugfix-regression')
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })), { expandEvidence: false })
  assert.equal(scenario.name, 'bugfix-regression')
  assert.equal(scenario.steps.length, 2)
  await view.unmount()
})

test('adds a step in the visual editor and keeps YAML valid', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  assert.ok(view.find({ text: /DAG-редактор/ }), JSON.stringify(view.tree()).slice(0, 5000))
  await view.press({ text: 'Добавить шаг' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps.length, 3)
  assert.equal(scenario.steps[2].id, 'step-3')
  await view.unmount()
})

test('removes a step and its dependency references', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Независимая проверка' })
  await view.press({ text: 'Удалить review' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps.length, 1)
  assert.equal(scenario.steps[0].id, 'implement')
  await view.unmount()
})

test('edits an agent visually with YAML round-trip', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Agent implement' }, 'kimi')
  await view.press({ text: 'Применить шаг' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps[0].agent, 'kimi')
  assert.equal(scenario.steps[0].fallback.includes('kimi'), false)
  await view.unmount()
})

test('selects and edits title, spec and acceptance in the inspector', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Независимая проверка' })
  await view.type({ label: 'Название шага' }, 'Audit', { replace: true })
  await view.type({ label: 'Задание шага' }, 'Check the result', { replace: true })
  await view.type({ label: 'Acceptance — команда на строку' }, 'npm test\nnpm run check', { replace: true })
  await view.press({ text: 'Применить шаг' })
  const step = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[1]
  assert.equal(step.title, 'Audit')
  assert.equal(step.spec, 'Check the result')
  assert.deepEqual(step.acceptance, ['npm test', 'npm run check'])
  assert.ok(view.find({ text: 'Audit' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('keeps the last graph on invalid YAML and recovers when corrected', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  const source = String(view.valueOf({ label: 'YAML-сценарий' }))
  await view.type({ label: 'YAML-сценарий' }, 'steps: [', { replace: true })
  assert.ok(view.find({ text: /последний валидный DAG/ }))
  assert.ok(view.find({ text: 'Реализация' }))
  await view.type({ label: 'YAML-сценарий' }, source.replace('Реализация', 'New title'), { replace: true })
  assert.ok(view.find({ text: 'New title' }))
  assert.equal(view.valueOf({ label: 'Название шага' }), 'New title')
  await view.unmount()
})

test('creates children and duplicates, then repairs selection after deletion', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Добавить дочерний' })
  let graph = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.deepEqual(graph.steps[2].needs, ['implement'])
  await view.press({ text: 'Дублировать' })
  graph = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(graph.steps[3].id, 'step-4')
  assert.deepEqual(graph.steps[3].needs, ['implement'])
  await view.press({ text: 'Удалить step-4' })
  assert.equal(view.valueOf({ label: 'Название шага' }), 'Реализация')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('dependency checkboxes reject cycles and allow removing an edge', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  assert.equal(view.find({ label: 'После implement' }), null)
  await view.toggle({ label: 'После review' })
  await view.press({ text: 'Применить шаг' })
  assert.ok(view.find({ text: /цикл зависимостей/ }))
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0].needs, [])
  await view.press({ text: 'Независимая проверка' })
  await view.toggle({ label: 'После implement' })
  await view.press({ text: 'Применить шаг' })
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[1].needs, [])
  assert.ok(view.find({ text: 'Волна 1 · параллельно' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
