import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario, taskSpec } from './scenario'

const gated = `name: evidence
objective: evidence
steps:
  - id: build
    title: Build
    spec: Implement
    agent: codex
    fallback: [kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
  - id: publish
    title: Publish
    needs: [build]
    spec: Publish after review
    agent: codex
    acceptance: [pnpm build]
`

test('adds an independent gate and routes downstream dependencies through it', () => {
  const scenario = parseScenario(gated)
  assert.deepEqual(scenario.steps.map((step) => step.id), ['build', 'build-evidence', 'publish'])
  assert.deepEqual(scenario.steps[2].needs, ['build-evidence'])
  assert.equal(scenario.steps[1].role, 'evidence')
  assert.equal(scenario.steps[1].gateFor, 'build')
  assert.match(taskSpec(scenario.steps[1]), /FIX-FIRST/)
})

test('rejects a reviewer who authored the implementation', () => {
  assert.throws(() => parseScenario(gated.replace('reviewAgent: claude', 'reviewAgent: codex')), /должен отличаться/)
})

test('FIX-FIRST creates a bounded repair and re-review before SHIP', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(gated))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.at(-1)?.taskId, 'task_build-evidence')

  h.state.output = 'FIX-FIRST: acceptance command failed'
  h.statuses.set('task_build-evidence', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'running')
  assert.equal(run.tasks['build-evidence'].status, 'superseded')
  assert.ok(run.tasks['build-repair-1'])
  assert.equal(run.tasks['build-repair-1-evidence'], undefined)

  await h.coordinator.tick(run.id)
  assert.equal(h.starts.at(-1)?.taskId, 'task_build-repair-1')
  h.statuses.set('task_build-repair-1', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.at(-1)?.taskId, 'task_build-evidence')
  assert.equal(h.starts.at(-1)?.retryOf, 'dispatch_2')
  h.statuses.set('task_build-evidence', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.at(-1)?.taskId, 'task_publish')
  h.statuses.set('task_publish', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'done')
})

test('BLOCKED stops the pipeline without creating a repair', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(gated))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  h.state.output = 'BLOCKED: incorrect architecture'
  h.statuses.set('task_build-evidence', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks['build-repair-1'], undefined)
})

test('maxRepairs zero turns the first FIX-FIRST into a terminal failure', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(gated.replace('reviewAgent: claude', 'maxRepairs: 0\n    reviewAgent: claude')))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  h.state.output = 'FIX-FIRST: test failed'
  h.statuses.set('task_build-evidence', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.match(run.tasks['build-evidence'].error ?? '', /лимит исправлений/)
})
