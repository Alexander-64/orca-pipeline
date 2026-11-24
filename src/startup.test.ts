import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

test('a blocked startup retains its dispatch and terminal without consuming fallback, then reuses them on explicit retry', async () => {
  const options: { startError?: string; startErrorDetails?: unknown; launchedTerminal?: string } = {
    startError: 'Agent startup blocked: agent-update-prompt',
    startErrorDetails: { result: { runId: 'run_1', taskId: 'task_a', dispatchId: 'ctx_blocked', state: 'failed', failedStage: 'agent_readiness' } },
    launchedTerminal: 'term_original'
  }
  const h = coordinatorFixture(options)
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', parseScenario(`name: blocked
objective: blocked
steps:
  - id: a
    title: Audit
    spec: Audit
    agent: codex
    acceptance: [pwd]
`))
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.a.attempts.length, 0)
  assert.deepEqual(run.tasks.a.startup, { dispatchId: 'ctx_blocked', terminalHandle: 'term_original', stage: 'agent_readiness' })
  options.startError = undefined
  await h.coordinator.retry(run.id)
  assert.equal(h.starts.length, 1)
  assert.equal(h.starts[0].retryOf, 'ctx_blocked')
  assert.equal(h.starts[0].reuseTerminal, 'term_original')
  assert.equal(run.tasks.a.attempts[0].agent, 'codex')
  assert.equal(run.tasks.a.startup, undefined)
})

test('a user can replace a disabled provider on the same failed Task without rerunning completed work', async () => {
  const options: { startError?: string } = { startError: 'Agent claude is disabled' }
  const h = coordinatorFixture(options)
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', parseScenario(`name: replace
objective: replace
steps:
  - id: a
    title: Review
    spec: Review
    agent: claude
    acceptance: [pwd]
`))
  assert.equal(run.status, 'failed')
  const taskId = run.tasks.a.taskId
  await h.coordinator.assignAgent(run.id, 'a', 'opencode')
  options.startError = undefined
  await h.coordinator.retry(run.id)
  assert.equal(run.tasks.a.taskId, taskId)
  assert.equal(h.starts[0].agent, 'opencode')
  assert.equal(run.tasks.a.attempts.length, 1)
  await assert.rejects(() => h.coordinator.assignAgent(run.id, 'a', 'codex'), /failed/)
})

test('a blocked native Task whose Dispatch was abandoned becomes retryable instead of staying running', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', parseScenario(`name: abandoned
objective: abandoned
steps:
  - id: a
    title: Review
    spec: Review
    agent: opencode
    acceptance: [pwd]
`))
  h.client.workerObservation = async () => ({ activity: 'unknown', workerState: 'abandoned' })
  h.statuses.set(run.tasks.a.taskId, 'blocked')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.a.status, 'failed')
  assert.equal(run.tasks.a.attempts[0].reason, 'worker-abandoned')
})

test('polling cannot fail a run from the old Task state while an explicit retry is launching', async () => {
  const options: { startError?: string } = { startError: 'blocked start' }
  const h = coordinatorFixture(options)
  const run = await h.coordinator.start(fixtureWorkspace, 'coordinator', parseScenario(`name: race
objective: race
steps:
  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [pwd]
`))
  options.startError = undefined
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const launching = new Promise<void>(resolve => { entered = resolve })
  const start = h.client.startWorker.bind(h.client)
  h.client.startWorker = async (...args) => { entered(); await gate; return start(...args) }
  const retry = h.coordinator.retry(run.id)
  await launching
  h.statuses.set(run.tasks.a.taskId, 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'running')
  release()
  await retry
  assert.equal(run.status, 'running')
  assert.equal(run.tasks.a.status, 'running')
  assert.equal(h.starts.length, 1)
})

test('cancelling an unsettled startup waits for guarded stop and persists pause on an unknown outcome', async () => {
  const options = {
    startError: 'Agent startup blocked: agent-update-prompt',
    startErrorDetails: { result: { runId: 'run_1', taskId: 'task_a', dispatchId: 'ctx_starting', state: 'failed', failedStage: 'agent_readiness' } },
    launchedTerminal: 'term_retained', stopError: 'stop_unknown'
  }
  const h = coordinatorFixture(options)
  const run = await h.coordinator.start(fixtureWorkspace, 'owner', parseScenario('name: cancel-start\nobjective: Cancel\nsteps:\n  - id: a\n    title: A\n    spec: A\n    agent: codex\n    acceptance: [pwd]\n'))
  await assert.rejects(() => h.coordinator.cancel(run.id), /stop_unknown/)
  assert.equal(run.status, 'paused')
  assert.equal(h.saved.at(-1)?.status, 'paused')
  assert.equal(run.tasks.a.startup?.dispatchId, 'ctx_starting')
  assert.equal(h.starts.length, 0)
  options.stopError = ''
  await h.coordinator.cancel(run.id)
  assert.equal(run.status, 'cancelled')
  assert.deepEqual(h.stops, ['ctx_starting'])
})
