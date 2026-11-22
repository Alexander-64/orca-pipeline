import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

function scenario(body: string) {
  return parseScenario(`name: lifecycle\nobjective: lifecycle\nsteps:\n${body}`)
}

test('starts independent steps together and unblocks a dependent only after all parents', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
  - id: b
    title: B
    spec: B
    agent: codex
    acceptance: [test]
  - id: c
    title: C
    needs: [a, b]
    spec: C
    agent: claude
    acceptance: [test]
`))
  assert.deepEqual(h.starts.map((start) => start.taskId), ['task_a', 'task_b'])
  assert.equal(run.tasks.c.status, 'pending')

  h.statuses.set('task_a', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.length, 2)
  h.statuses.set('task_b', 'completed')
  await h.coordinator.tick(run.id)
  assert.deepEqual(h.starts[2], { taskId: 'task_c', agent: 'claude', retryOf: undefined })
})

test('pause observes completion but does not dispatch the next step', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
  - id: c
    title: C
    needs: [a]
    spec: C
    agent: claude
    acceptance: [test]
`))
  await h.coordinator.pause(run.id)
  h.statuses.set('task_a', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'paused')
  assert.equal(run.tasks.a.status, 'done')
  assert.equal(h.starts.length, 1)
})

test('cancel fences every active attempt and prevents further dispatch', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
  - id: b
    title: B
    spec: B
    agent: claude
    acceptance: [test]
`))
  await h.coordinator.cancel(run.id)
  assert.equal(run.status, 'cancelled')
  assert.deepEqual(h.stops, ['dispatch_1', 'dispatch_2'])
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.length, 2)
})

test('network failure does not trigger provider failover', async () => {
  const h = coordinatorFixture()
  h.state.output = 'connection reset by peer'
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude]
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 1)
})

test('quota without a fallback leaves a useful failure and no duplicate', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.match(run.tasks.a.error ?? '', /Quota exhausted/)
  assert.equal(h.starts.length, 1)
})

test('maxAttempts one forbids automatic retry', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude]
    maxAttempts: 1
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 1)
})

test('failed manual stop never starts a replacement', async () => {
  const h = coordinatorFixture({ stopError: 'stop_unknown' })
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude]
    acceptance: [test]
`))
  await assert.rejects(() => h.coordinator.switchAgent(run.id, 'a'), /stop_unknown/)
  assert.equal(h.starts.length, 1)
  assert.equal(run.tasks.a.attempts[0].status, 'running')
})

test('handoff failure fences the replacement instead of starting a third attempt', async () => {
  const h = coordinatorFixture({ handoffError: 'mailbox unavailable' })
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude, kimi]
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 2)
  assert.deepEqual(h.stops, ['dispatch_2'])
  assert.equal(run.tasks.a.attempts[1].reason, 'handoff-delivery-failed')
})

test('paused run does not failover after a quota failure', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude]
    acceptance: [test]
`))
  await h.coordinator.pause(run.id)
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 1)
})

test('retry refuses a failed run with no remaining fallback before binding', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  await assert.rejects(() => h.coordinator.retry(run.id), /has no fallback/)
  assert.equal(h.state.binds, 0)
  assert.equal(h.starts.length, 1)
})

test('creates Beads in dependency order even when YAML is reversed', async () => {
  const h = coordinatorFixture()
  await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: review
    title: Review
    needs: [build]
    spec: Review
    agent: claude
    acceptance: [test]
  - id: build
    title: Build
    spec: Build
    agent: codex
    acceptance: [test]
`))
  assert.deepEqual(h.beadOrder, ['build', 'review'])
})
