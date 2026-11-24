import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard, parallelDraft } from './testData'
import { parseScenario } from './scenario'
import { DEFAULT_SCENARIO } from './types'

function hostWithValidation() {
  return mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => demoDashboard,
      'scenario.validate': ({ source }) => JSON.parse(JSON.stringify({ scenario: parseScenario(source) }))
    }
  })
}

const conditionsDraft = `version: 2
name: conditions-ui
objective: Conditional UI
steps:
 - {id: decide, title: Decide, spec: Inspect, agent: pi, acceptance: [pwd], outputSchema: {decision: {type: string, enum: [improve, pass]}}}
 - {id: improve, title: Improve, spec: Recommend, agent: pi, acceptance: [pwd], needs: [decide]}
`

test('builds a typed condition and join through panel controls without editing YAML', async () => {
  const view = await mount(panel, { host: hostWithValidation(), persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.draft': conditionsDraft } } })
  await view.press({ text: 'Improve' })
  await view.select({ label: 'Поле предшественника' }, 'decide:decision')
  await view.select({ label: 'Сравнение' }, 'eq')
  await view.select({ label: 'Значение условия' }, 'pass')
  await view.press({ text: 'Добавить проверку' })
  await view.select({ label: 'Когда начинать шаг' }, 'all_settled')
  await view.press({ text: 'Применить шаг' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })), { expandEvidence: false })
  assert.equal(scenario.version, 2)
  assert.deepEqual(scenario.steps[1].when, { step: 'decide', field: 'decision', op: 'eq', value: 'pass' })
  assert.equal(scenario.steps[1].join, 'all_settled')
  assert.equal(scenario.steps[1].approval, undefined)
  await view.press({ text: 'Убрать условие 1' })
  await view.press({ text: 'Применить шаг' })
  assert.equal(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[1].when, undefined)
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('applies a workflow template to the YAML draft', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Шаблон' }, 'bugfix-regression')
  await view.press({ text: 'Далее: шаги и агенты' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })), { expandEvidence: false })
  assert.equal(scenario.name, 'bugfix-regression')
  assert.equal(scenario.steps.length, 2)
  await view.unmount()
})

test('adds a step in the visual editor and keeps YAML valid', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  assert.ok(view.find({ text: /DAG-редактор/ }), JSON.stringify(view.tree()).slice(0, 5000))
  await view.press({ text: 'Добавить шаг' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps.length, 3)
  assert.equal(scenario.steps[2].id, 'step-3')
  await view.unmount()
})

test('removes a step and its dependency references', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  await view.press({ text: 'Независимая проверка' })
  await view.press({ text: 'Удалить review' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps.length, 1)
  assert.equal(scenario.steps[0].id, 'implement')
  await view.unmount()
})

test('edits an agent visually with YAML round-trip', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  await view.select({ label: 'Agent implement' }, 'kimi')
  await view.press({ text: 'Применить шаг' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })))
  assert.equal(scenario.steps[0].agent, 'kimi')
  assert.equal(scenario.steps[0].fallback.includes('kimi'), false)
  await view.unmount()
})

test('selects and edits title, spec and acceptance in the inspector', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
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
  await view.select({ label: 'Этап pipeline' }, 'steps')
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
  await view.select({ label: 'Этап pipeline' }, 'steps')
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

test('dependency cards prevent cycles and add or remove inputs through named cards', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  assert.equal(view.find({ text: 'Добавить #1' }), null)
  assert.equal(view.find({ text: 'Добавить #2' })?.disabled, true)
  assert.ok(view.find({ text: 'Следует за этим шагом — связь создаст цикл' }))
  await view.press({ text: 'Независимая проверка' })
  assert.ok(view.find({ text: 'Реализация' }))
  await view.press({ text: 'Убрать #1' })
  assert.ok(view.find({ text: 'Не ждёт другие шаги и может выполняться параллельно с ними.' }))
  await view.press({ text: 'Применить шаг' })
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[1].needs, [])
  assert.ok(view.find({ text: 'Волна 1 · параллельно' }))
  await view.press({ text: 'Добавить #1' })
  await view.select({ label: 'Когда начинать шаг' }, 'all_settled')
  await view.type({ label: 'Подтверждение перед запуском' }, 'Проверить отчёт', { replace: true })
  await view.press({ text: 'Применить шаг' })
  const saved = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[1]
  assert.deepEqual(saved.needs, ['implement'])
  assert.equal(saved.join, 'all_settled')
  assert.equal(saved.approval, 'Проверить отчёт')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('Kimi remains visible as primary in the chain and becomes an available fallback on another primary', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  await view.select({ label: 'Agent implement' }, 'kimi')
  assert.ok(view.find({ text: '1 · kimi · основной' }))
  await view.select({ label: 'Agent implement' }, 'codex')
  assert.ok(view.find({ text: '+ kimi' }))
  await view.press({ text: '+ kimi' })
  await view.press({ text: 'Применить шаг' })
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0].fallback, ['claude', 'kimi'])
  await view.unmount()
})


test('editor follows fork/join links and highlights immediate inputs and successors', async () => {
  const view = await mount(panel, { host: hostWithValidation(), persisted: { plugin: {
    'pipeline.stage': 'steps', 'pipeline.draft': parallelDraft
  } } })
  assert.ok(view.find({ text: 'Волна 1 · параллельно' }))
  await view.press({ text: 'Build' })
  assert.ok(view.find({ text: 'Вход выбранного шага' }))
  assert.ok(view.find({ text: '#1 → #3' }))
  assert.ok(view.find({ text: '#2 → #3' }))
  await view.press({ text: '#2 → #3' })
  assert.equal(view.valueOf({ label: 'Название шага' }), 'Design')
  assert.ok(view.find({ text: 'Следует за выбранным' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('reserve agent cards support priority changes, removal and switching primary without duplicates', async () => {
  const view = await mount(panel, { host: hostWithValidation(), persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.draft': DEFAULT_SCENARIO.replace('fallback: [claude, kimi]', 'fallback: [claude]'), 'pipeline.editor-view': 'split' } } })
  await view.select({ label: 'Этап pipeline' }, 'steps')
  await view.press({ text: '+ kimi' })
  const moveUp = view.findAll({ type: 'Button', text: '↑' }).find(item => item.props.tooltip === 'Выше: kimi')!
  await view.press(moveUp)
  await view.press({ text: 'Применить шаг' })
  let step = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0]
  assert.deepEqual(step.fallback, ['kimi', 'claude'])
  await view.press({ text: 'Убрать claude' })
  await view.select({ label: 'Проверяющий агент' }, 'kimi')
  await view.select({ label: 'Agent implement' }, 'kimi')
  assert.equal(view.valueOf({ label: 'Проверяющий агент' }), 'none')
  assert.ok(view.find({ text: 'Резервных агентов пока нет' }))
  await view.press({ text: 'Применить шаг' })
  step = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0]
  assert.equal(step.agent, 'kimi')
  assert.deepEqual(step.fallback, [])
  assert.equal(step.reviewAgent, undefined)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})


test('dependency picker disables transitive successors while keeping independent inputs available', async () => {
  const source = `name: transitive-inputs
objective: Check dependencies
steps:
 - {id: a, title: Начало, spec: Inspect, agent: codex, acceptance: [pwd]}
 - {id: b, title: Середина, spec: Inspect, agent: codex, acceptance: [pwd], needs: [a]}
 - {id: c, title: Конец, spec: Inspect, agent: codex, acceptance: [pwd], needs: [b]}
 - {id: d, title: Другая ветка, spec: Inspect, agent: codex, acceptance: [pwd]}
`
  const view = await mount(panel, { host: hostWithValidation(), persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.draft': source, 'pipeline.editor-view': 'split' } } })
  assert.equal(view.find({ text: 'Добавить #2' })?.disabled, true)
  assert.equal(view.find({ text: 'Добавить #3' })?.disabled, true)
  assert.equal(view.find({ text: 'Добавить #4' })?.disabled, false)
  await view.press({ text: 'Добавить #4' })
  await view.press({ text: 'Применить шаг' })
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML-сценарий' }))).steps[0].needs, ['d'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('model and effort controls use agent catalogs, save reserve choices and clear incompatible picks', async () => {
  const catalogs = {
    codex: { observedAt: 1000, models: [
      { id: 'model-a', label: 'Model A', efforts: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
      { id: 'model-b', label: 'Model B', efforts: [] }
    ] },
    claude: { observedAt: 1000, models: [{ id: 'model-c', label: 'Model C', efforts: [{ value: 'medium', label: 'Medium' }] }] }
  }
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, modelCatalogs: catalogs }) } }),
    persisted: { plugin: { 'pipeline.tab': 'scenario', 'pipeline.stage': 'steps', 'pipeline.draft': DEFAULT_SCENARIO, 'pipeline.run-mode': 'new', 'pipeline.editor-view': 'split' } } })
  assert.deepEqual(view.errors, [])
  assert.ok(view.find({ label: 'Модель · Основной агент' }), JSON.stringify(view.tree()).slice(0, 500))
  await view.select({ label: 'Модель · Основной агент' }, 'model-a')
  await view.select({ label: 'Усилие · Основной агент' }, 'high')
  await view.toggle({ label: 'Модель резервного агента · claude' })
  await view.select({ label: 'Модель · Резерв claude' }, 'model-c')
  await view.select({ label: 'Усилие · Резерв claude' }, 'medium')
  await view.press({ text: 'Применить шаг' })
  let step = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })), { expandEvidence: false }).steps[0]
  assert.equal(step.model, 'model-a'); assert.equal(step.effort, 'high')
  assert.deepEqual(step.agentPreferences?.claude, { model: 'model-c', effort: 'medium' })
  await view.select({ label: 'Модель · Основной агент' }, 'model-b')
  assert.equal(view.find({ label: 'Усилие · Основной агент' }), null)
  await view.press({ text: 'Применить шаг' })
  step = parseScenario(String(view.valueOf({ label: 'YAML-сценарий' })), { expandEvidence: false }).steps[0]
  assert.equal(step.effort, undefined)
  await view.select({ label: 'Agent implement' }, 'claude')
  assert.equal(view.valueOf({ label: 'Модель · Основной агент' }), '__agent_default__')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})
