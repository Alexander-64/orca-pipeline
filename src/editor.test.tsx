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
  await view.select({ label: 'Template' }, 'bugfix-regression')
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML scenario' })), { expandEvidence: false })
  assert.equal(scenario.name, 'bugfix-regression')
  assert.equal(scenario.steps.length, 2)
  await view.unmount()
})

test('adds a step in the visual editor and keeps YAML valid', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  assert.ok(view.find({ text: /DAG editor/ }), JSON.stringify(view.tree()).slice(0, 5000))
  await view.press({ text: 'Add step' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML scenario' })))
  assert.equal(scenario.steps.length, 3)
  assert.equal(scenario.steps[2].id, 'step-3')
  await view.unmount()
})

test('removes a step and its dependency references', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Independent review' })
  await view.press({ text: 'Delete review' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML scenario' })))
  assert.equal(scenario.steps.length, 1)
  assert.equal(scenario.steps[0].id, 'implement')
  await view.unmount()
})

test('edits an agent visually with YAML round-trip', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.select({ label: 'Agent implement' }, 'kimi')
  await view.press({ text: 'Apply step' })
  const scenario = parseScenario(String(view.valueOf({ label: 'YAML scenario' })))
  assert.equal(scenario.steps[0].agent, 'kimi')
  assert.equal(scenario.steps[0].fallback.includes('kimi'), false)
  await view.unmount()
})

test('selects and edits title, spec and acceptance in the inspector', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Independent review' })
  await view.type({ label: 'Step title' }, 'Audit', { replace: true })
  await view.type({ label: 'Step instructions' }, 'Check the result', { replace: true })
  await view.type({ label: 'Acceptance checks, one command per line' }, 'npm test\nnpm run check', { replace: true })
  await view.press({ text: 'Apply step' })
  const step = parseScenario(String(view.valueOf({ label: 'YAML scenario' }))).steps[1]
  assert.equal(step.title, 'Audit')
  assert.equal(step.spec, 'Check the result')
  assert.deepEqual(step.acceptance, ['npm test', 'npm run check'])
  assert.ok(view.find({ text: 'Audit' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('keeps the last graph on invalid YAML and recovers when corrected', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  const source = String(view.valueOf({ label: 'YAML scenario' }))
  await view.type({ label: 'YAML scenario' }, 'steps: [', { replace: true })
  assert.ok(view.find({ text: /last valid DAG/ }))
  assert.ok(view.find({ text: 'Implementation' }))
  await view.type({ label: 'YAML scenario' }, source.replace('Implementation', 'New title'), { replace: true })
  assert.ok(view.find({ text: 'New title' }))
  assert.equal(view.valueOf({ label: 'Step title' }), 'New title')
  await view.unmount()
})

test('creates children and duplicates, then repairs selection after deletion', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  await view.press({ text: 'Add dependent step' })
  let graph = parseScenario(String(view.valueOf({ label: 'YAML scenario' })))
  assert.deepEqual(graph.steps[2].needs, ['implement'])
  await view.press({ text: 'Duplicate' })
  graph = parseScenario(String(view.valueOf({ label: 'YAML scenario' })))
  assert.equal(graph.steps[3].id, 'step-4')
  assert.deepEqual(graph.steps[3].needs, ['implement'])
  await view.press({ text: 'Delete step-4' })
  assert.equal(view.valueOf({ label: 'Step title' }), 'Implementation')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('dependency checkboxes reject cycles and allow removing an edge', async () => {
  const view = await mount(panel, { host: hostWithValidation() })
  assert.equal(view.find({ label: 'After implement' }), null)
  await view.toggle({ label: 'After review' })
  await view.press({ text: 'Apply step' })
  assert.ok(view.find({ text: /dependency cycle/ }))
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML scenario' }))).steps[0].needs, [])
  await view.press({ text: 'Independent review' })
  await view.toggle({ label: 'After implement' })
  await view.press({ text: 'Apply step' })
  assert.deepEqual(parseScenario(String(view.valueOf({ label: 'YAML scenario' }))).steps[1].needs, [])
  assert.ok(view.find({ text: 'Wave 1 · parallel' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
