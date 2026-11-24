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
  assert.throws(() => parseScenario(valid.replace('needs: [build]', 'needs: [review]')), /зависит от себя|цикл/)
  assert.throws(() => parseScenario(valid.replace('    acceptance: [pnpm test]\n', '')), /acceptance/)
})

test('rejects ambiguous remote placement and effort without model', () => {
  const remote = valid.replace('agent: codex', 'agent: codex\n    placement: { host: server, worktree: current }')
  assert.throws(() => parseScenario(remote), /remote/)
  const effort = valid.replace('agent: codex', 'agent: codex\n    effort: high')
  assert.throws(() => parseScenario(effort), /effort/)
})

test('graph positions survive serialization without changing dependency semantics', async () => {
  const { serializeScenario } = await import('./scenario')
  const { DEFAULT_SCENARIO } = await import('./types')
  const graph = parseScenario(DEFAULT_SCENARIO, { expandEvidence: false })
  graph.layout = { implement: { x: 130, y: 240 }, review: { x: 520, y: 90 } }
  const restored = parseScenario(serializeScenario(graph), { expandEvidence: false })
  assert.deepEqual(restored.layout, graph.layout)
  assert.deepEqual(restored.steps[1].needs, ['implement'])
  assert.throws(() => parseScenario(serializeScenario({ ...graph, layout: { implement: { x: -1, y: 0 } } })), /координаты/)
})

test('v1 dependency instructions use the pipeline workspace even when source checks run elsewhere', () => {
  const step = parseScenario(valid).steps[1]
  const spec = taskSpec(step, undefined, 'run_1', true, '/pipeline/workspace')
  assert.match(spec, /Pipeline inputs: build/)
  assert.match(spec, /\/pipeline\/workspace\/\.agent-pipeline\/artifacts\/run_1\/review.checkpoint.json/)
  assert.match(spec, /separate from the task source directory/)
})

test('detects a source-only task boundary but allows ordinary references to source paths', async () => {
  const { workspaceRestrictionConflicts } = await import('./scenario')
  const scenario = parseScenario(valid)
  scenario.steps[0].spec = 'Работай только в /repo/specs. Не меняй файлы.'
  scenario.steps[1].spec = 'Прочитай /repo/specs/README.md и работай в своей копии.'
  assert.deepEqual(workspaceRestrictionConflicts(scenario, '/repo/specs/').map(step => step.id), ['build'])
  scenario.steps[0].spec = 'Work only in "/repo/specs".'
  assert.equal(workspaceRestrictionConflicts(scenario, '/repo/specs').length, 1)
})
