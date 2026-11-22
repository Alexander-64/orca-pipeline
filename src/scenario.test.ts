import { assert, test } from 'orca/testing'
import { parseScenario, taskSpec } from './scenario'

const valid = `name: test
objective: test objective
steps:
  - id: build
    title: Build
    spec: Implement the change
    agent: codex
    fallback: [claude]
    acceptance: [pnpm test]
  - id: review
    title: Review
    needs: [build]
    spec: Review the change
    agent: claude
    acceptance: [pnpm lint]
`

test('parses and normalizes a valid DAG', () => {
  const scenario = parseScenario(valid)
  assert.equal(scenario.steps.length, 2)
  assert.equal(scenario.steps[0].placement.host, 'local')
  assert.equal(scenario.steps[0].placement.worktree, 'current')
  assert.equal(scenario.steps[0].maxAttempts, 3)
  assert.deepEqual(scenario.steps[1].needs, ['build'])
  assert.match(taskSpec(scenario.steps[0]), /pnpm test/)
})

test('rejects cycles and missing acceptance', () => {
  assert.throws(() => parseScenario(valid.replace('needs: [build]', 'needs: [review]')), /depends on itself|cycle/)
  assert.throws(() => parseScenario(valid.replace('    acceptance: [pnpm test]\n', '')), /acceptance/)
})

test('rejects ambiguous remote placement and effort without model', () => {
  const remote = valid.replace('agent: codex', 'agent: codex\n    placement: { host: server, worktree: current }')
  assert.throws(() => parseScenario(remote), /remote/)
  const effort = valid.replace('agent: codex', 'agent: codex\n    effort: high')
  assert.throws(() => parseScenario(effort), /effort/)
})
