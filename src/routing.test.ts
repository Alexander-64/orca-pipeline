import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

const source = `name: routing
objective: routing
roles:
  implementation:
    agent: codex
    fallback: [opencode, kimi]
    model: gpt-default
    effort: high
  review:
    agent: claude
    fallback: [kimi]
steps:
  - id: build
    title: Build
    role: implementation
    spec: Work
    acceptance: [test]
  - id: review
    title: Review
    role: review
    needs: [build]
    spec: Review
    acceptance: [test]
`

test('applies role policies and records the routing reason', () => {
  const scenario = parseScenario(source)
  assert.equal(scenario.steps[0].agent, 'codex')
  assert.deepEqual(scenario.steps[0].fallback, ['opencode', 'kimi'])
  assert.equal(scenario.steps[0].model, 'gpt-default')
  assert.equal(scenario.steps[0].effort, 'high')
  assert.equal(scenario.steps[0].routingReason, 'role implementation → codex')
  assert.equal(scenario.steps[1].agent, 'claude')
})

test('allows a step to override its role policy', () => {
  const scenario = parseScenario(source.replace('    role: implementation', '    role: implementation\n    agent: kimi\n    model: custom'))
  assert.equal(scenario.steps[0].agent, 'kimi')
  assert.equal(scenario.steps[0].model, 'custom')
  assert.equal(scenario.steps[0].effort, 'high')
})

test('rejects an unknown role', () => {
  assert.throws(() => parseScenario(source.replace('role: implementation', 'role: missing')), /неизвестная роль/)
})

test('rejects inherited effort without an inherited model', () => {
  const withoutModel = source.replace('    model: gpt-default\n', '')
  assert.throws(() => parseScenario(withoutModel), /effort требует model/)
})

test('coordinator keeps the role reason on the attempt', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(source))
  assert.equal(run.tasks.build.attempts[0].selectionReason, 'role implementation → codex')
})
