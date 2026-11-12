import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

const twoSteps = `  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
  - id: b
    title: B
    spec: B
    agent: codex
    acceptance: [test]
`

test('maxConcurrent one starts the next step only after a slot is released', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: cap
objective: cap
maxConcurrent: 1
steps:
${twoSteps}`))
  assert.equal(h.starts.length, 1)
  h.statuses.set('task_a', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.length, 2)
  assert.equal(h.starts[1].taskId, 'task_b')
})

test('provider limit is independent from the global slot count', async () => {
  const h = coordinatorFixture()
  await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: cap
objective: cap
maxConcurrent: 3
providerLimits: { codex: 1, claude: 1 }
steps:
  - id: a
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
    spec: C
    agent: claude
    acceptance: [test]
`))
  assert.deepEqual(h.starts.map((start) => start.taskId).sort(), ['task_a', 'task_c'])
})

test('host limit does not block a different execution host', async () => {
  const h = coordinatorFixture()
  await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: cap
objective: cap
hostLimits: { local: 1, remote: 1 }
steps:
  - id: a
    title: A
    spec: A
    agent: codex
    placement: { host: local, worktree: current }
    acceptance: [test]
  - id: b
    title: B
    spec: B
    agent: codex
    placement: { host: local, worktree: current }
    acceptance: [test]
  - id: c
    title: C
    spec: C
    agent: claude
    placement: { host: remote, worktree: id:repo::remote }
    acceptance: [test]
`))
  assert.deepEqual(h.starts.map((start) => start.taskId).sort(), ['task_a', 'task_c'])
})

test('failed attempt releases its provider slot before fallback', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: cap
objective: cap
maxConcurrent: 1
steps:
  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [claude]
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts.at(-1)?.agent, 'claude')
})

test('rejects zero concurrency limits', () => {
  assert.throws(() => parseScenario(`name: cap
objective: cap
maxConcurrent: 0
steps:
${twoSteps}`), /maxConcurrent/)
  assert.throws(() => parseScenario(`name: cap
objective: cap
providerLimits: { codex: 0 }
steps:
${twoSteps}`), /providerLimits.codex/)
})
