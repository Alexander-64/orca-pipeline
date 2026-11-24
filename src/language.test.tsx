import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard, demoRun } from './testData'
import { defaultScenario, scenarioTemplate, SCENARIO_TEMPLATES } from './templates'
import { diagnosticText } from './diagnostics'
import { parseScenario } from './scenario'
import { translate } from './i18n'

test('a new installation starts in English and opens a usable English graph', async () => {
  const host = mockHost({ requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [] }) } })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'English / Русский' }), 'en')
  await view.press({ text: 'Next: steps and agents' })
  assert.equal(view.valueOf({ label: 'Step title' }), 'Implementation')
  await view.press({ text: 'Add parallel step' })
  assert.equal(view.valueOf({ label: 'Step title' }), 'Step 3')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the language switch persists and preserves the run and its original output', async () => {
  const run = structuredClone(demoRun)
  run.tasks.build.attempts[0].output = 'Уникальный ответ $& {0}'
  const host = mockHost({ requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [run] }) } })
  let view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'result', 'pipeline.run': run.id } } })
  assert.ok(view.find({ text: 'All step results' }))
  await view.select({ label: 'English / Русский' }, 'ru')
  assert.ok(view.find({ text: 'Результаты всех шагов' }))
  assert.equal(view.valueOf({ label: 'Прогон' }), run.id)
  assert.equal(host.data().settings.interfaceLanguage, 'ru')
  const saved = view.persisted.plugin
  await view.unmount()
  view = await mount(panel, { host, persisted: { plugin: saved } })
  assert.equal(view.valueOf({ label: 'English / Русский' }), 'ru')
  await view.select({ label: 'English / Русский' }, 'en')
  assert.equal(view.valueOf({ label: 'Run' }), run.id)
  assert.ok(JSON.stringify(view.tree()).includes(run.tasks.build.attempts[0].output))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('switching language never rewrites invalid or in-progress YAML', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [] }) } }),
    persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.editor-view': 'split' } } })
  await view.type({ label: 'Scenario YAML' }, 'name: Черновик\nsteps: [', { replace: true })
  await view.select({ label: 'English / Русский' }, 'ru')
  assert.equal(view.valueOf({ label: 'YAML-сценарий' }), 'name: Черновик\nsteps: [')
  assert.ok(view.find({ text: /последний валидный DAG/ }))
  await view.unmount()
})

test('localized templates have equivalent dependency graphs and acceptance commands', () => {
  for (const id of ['default', ...Object.keys(SCENARIO_TEMPLATES)]) {
    const plans = (['en', 'ru'] as const).map(lang => parseScenario(id === 'default' ? defaultScenario(lang) : scenarioTemplate(id, lang)))
    assert.notEqual(plans[0].objective, plans[1].objective)
    const edges = (plan: typeof plans[number]) => plan.steps.map(step => [step.id, step.needs, step.agent, step.acceptance])
    assert.deepEqual(edges(plans[0]), edges(plans[1]))
  }
  assert.equal(translate('en', 'After: {0}', 'Шаг $& {1}'), 'After: Шаг $& {1}')
  assert.equal(diagnosticText('en', 'steps: цикл зависимостей через a'), 'steps: dependency cycle through a')
  assert.equal(diagnosticText('en', 'Проверяю журнал запуска и фактических исполнителей.'), 'Checking the launch journal against active agent sessions.')
  assert.equal(diagnosticText('en', 'native error: Ошибка'), 'native error: Ошибка')
})
