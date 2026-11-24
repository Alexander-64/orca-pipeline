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
  assert.match(run.tasks.a.error ?? '', /Лимит исчерпан/)
  assert.equal(h.starts.length, 1)
})

test('settles the last Kimi attempt when a completed turn hit quota but Orca still reports dispatched', async () => {
  const h = coordinatorFixture()
  const abandoned: string[] = []
  h.client.abandonWorker = async id => { abandoned.push(id); h.statuses.set('task_a', 'blocked') }
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    fallback: [kimi]
    maxAttempts: 2
    acceptance: [test]
`))
  h.statuses.set('task_a', 'failed')
  await h.coordinator.tick(run.id)
  assert.equal(h.starts[1].agent, 'kimi')

  h.state.activityDone = true
  h.state.output = 'Test output: the mocked response returned HTTP 429'
  await h.coordinator.tick(run.id)
  assert.equal(run.tasks.a.status, 'running')
  assert.deepEqual(abandoned, [])

  h.state.output = "   Error: [provider.api_error] You've reached your monthly usage limit for this billing cycle.\n >"
  h.state.activityDone = false
  await h.coordinator.tick(run.id)
  assert.equal(run.tasks.a.status, 'running')
  assert.deepEqual(abandoned, [])

  h.state.activityDone = true
  await h.coordinator.tick(run.id)
  await h.coordinator.tick(run.id)
  assert.deepEqual(abandoned, ['dispatch_2'])
  assert.deepEqual(h.stops, [])
  assert.equal(h.starts.length, 2)
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.a.status, 'failed')
  assert.equal(run.tasks.a.attempts[1].reason, 'quota')
  assert.match(run.tasks.a.error ?? '', /monthly usage limit/)
  assert.equal(h.saved.at(-1)?.tasks.a.attempts[1].status, 'failed')
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

test('draft agent settings preserve completed work and allow an explicit retry after the fallback is exhausted', async () => {
  const h = coordinatorFixture()
  const plan = scenario(`  - id: a
    title: A
    spec: Work A
    agent: codex
    fallback: [kimi]
    acceptance: [test]
  - id: b
    title: B
    spec: Work B
    needs: [a]
    agent: codex
    fallback: [kimi]
    maxAttempts: 2
    acceptance: [test]
  - id: c
    title: C
    spec: Work C
    needs: [b]
    agent: opencode
    acceptance: [test]
`)
  const draft = { ...plan, steps: plan.steps.map(step => ({ ...step, agent: 'codex', fallback: [] })) }
  const started = await h.coordinator.start(fixtureWorkspace, 'term_1', plan)
  h.statuses.set('task_a', 'completed')
  await h.coordinator.tick(started.id)
  h.statuses.set('task_b', 'failed')
  await h.coordinator.tick(started.id)
  h.statuses.set('task_b', 'failed')
  await h.coordinator.tick(started.id)
  const run = JSON.parse(JSON.stringify(started)) as typeof started
  h.coordinator.restore([run], { autoResume: false })
  const completed = structuredClone(run.tasks.a)
  const attempts = structuredClone(run.tasks.b.attempts)
  const changedInstructions = structuredClone(draft)
  changedInstructions.steps[1].spec = 'Different task'
  await assert.rejects(() => h.coordinator.applyAgentRouting(run.id, changedInstructions), /apart from agent settings/)
  await h.coordinator.applyAgentRouting(run.id, draft)
  assert.deepEqual(run.tasks.a, completed)
  assert.deepEqual(run.tasks.b.attempts, attempts)
  assert.equal(run.tasks.c.agent, 'codex')
  assert.equal(h.starts.length, 3)
  await h.coordinator.retry(run.id)
  assert.deepEqual(h.starts[3], { taskId: 'task_b', agent: 'codex', retryOf: 'dispatch_3' })
  assert.deepEqual(run.tasks.a, completed)
  assert.equal(run.tasks.b.retrySameAgent, undefined)
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

test('paused quota fallback stays queued until explicit resume', async () => {
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
  assert.equal(run.status, 'paused')
  assert.equal(run.tasks.a.status, 'pending')
  assert.equal(run.tasks.a.retryRequested, true)
  assert.equal(h.starts.length, 1)
  await h.coordinator.resume(run.id)
  assert.equal(h.starts.length, 2)
  assert.equal(h.starts[1].agent, 'claude')
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
  await assert.rejects(() => h.coordinator.retry(run.id), /не осталось fallback/)
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

test('visible run retains completed worker windows, legacy runs still release them', async () => {
  for (const visibleWorkers of [true, false]) {
    const h = coordinatorFixture()
    const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario(`  - id: a
    title: A
    spec: A
    agent: codex
    acceptance: [test]
`), { visibleWorkers })
    const dispatch = run.tasks.a.attempts[0].dispatchId
    h.statuses.set(run.tasks.a.taskId, 'completed')
    await h.coordinator.tick(run.id)
    assert.equal(run.status, 'done')
    assert.deepEqual(h.releases, visibleWorkers ? [] : [dispatch])
  }
})

test('v1 writes predecessor reports to the checkpoint before launching the dependent', async () => {
  const h = coordinatorFixture()
  const checkpoints: { stepId: string; body: string }[] = []
  h.client.prepareCheckpoint = async (_run, step, _taskId, body) => {
    assert.equal(h.starts.some(start => start.taskId === 'task_c'), false)
    checkpoints.push({ stepId: step.id, body })
  }
  const run = await h.coordinator.start(fixtureWorkspace, 'owner', scenario(`  - {id: a, title: A, spec: A, agent: codex, acceptance: [pwd]}
  - {id: c, title: C, spec: C, agent: claude, needs: [a], acceptance: [pwd]}`))
  h.state.output = 'Verified source report with path:line'
  h.statuses.set('task_a', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0].stepId, 'c')
  assert.match(checkpoints[0].body, /Verified source report with path:line/)
  assert.match(checkpoints[0].body, /"status": "done"/)
  assert.equal(h.starts.at(-1)!.taskId, 'task_c')
})

test('a failed run still observes an active workers question without launching or retrying anything', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'owner', scenario('  - {id: a, title: A, spec: A, agent: codex, acceptance: [pwd]}'))
  run.status = 'failed'; run.tasks.a.status = 'blocked'
  h.client.workerObservation = async () => ({ activity: 'waiting-user', interaction: 'native', questions: [{ id: 'q1', question: 'Need context', state: 'waiting', askedAt: '' }] })
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.a.questions![0].question, 'Need context')
  assert.equal(h.starts.length, 1)
  assert.deepEqual(h.stops, [])
})

test('excludes invalid failed/pending placeholders with an audit record and preserves completed/active steps', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'owner', scenario(`  - {id: a, title: A, spec: A, agent: codex, acceptance: [pwd]}
  - {id: extra, title: Extra, spec: Placeholder, agent: codex, acceptance: [test]}
  - {id: tail, title: Tail, spec: Placeholder, needs: [extra], agent: codex, acceptance: [test]}`))
  run.status = 'failed'; run.tasks.extra.status = 'failed'; run.tasks.extra.attempts[0].status = 'failed'
  await assert.rejects(() => h.coordinator.excludeInvalidSteps(run.id, ['a'], 'bad config'), /незавершённое/)
  await assert.rejects(() => h.coordinator.excludeInvalidSteps(run.id, ['extra'], 'bad config'), /зависит/)
  await h.coordinator.excludeInvalidSteps(run.id, ['extra', 'tail'], 'npm is invalid for a Python specification repository')
  assert.deepEqual(run.scenario.steps.map(step => step.id), ['a'])
  assert.equal(run.excludedSteps!.length, 2)
  assert.equal(run.excludedSteps![0].task.status, 'failed')
  assert.equal(run.excludedSteps![0].task.attempts[0].status, 'failed')
  assert.equal(run.tasks.a.attempts[0].status, 'running')
  assert.equal(h.starts.length, 2)
  run.tasks.a.status = 'done'; run.tasks.a.attempts[0].status = 'done'
  await assert.rejects(() => h.coordinator.excludeInvalidSteps(run.id, ['a'], 'bad config'), /завершён/)
})

test('repairs pending legacy context with absolute inputs without restarting completed or active workers', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'owner', scenario(`  - {id: a, title: A, spec: A, agent: codex, acceptance: [pwd]}
  - {id: b, title: B, spec: B, needs: [a], agent: codex, acceptance: [pwd]}`))
  run.status = 'paused'
  h.client.reviseTask = async (_run, _step, _revision, spec, deps) => {
    assert.match(spec, /\/work\/\.agent-pipeline\/artifacts\/run_1\/b.checkpoint.json/)
    assert.deepEqual(deps, ['task_a'])
    return 'replacement-b'
  }
  await assert.rejects(() => h.coordinator.refreshPendingContext(run.id, 'a'), /не запускавшемуся/)
  await h.coordinator.refreshPendingContext(run.id, 'b')
  assert.equal(run.tasks.b.taskId, 'replacement-b')
  assert.equal(run.tasks.b.history![0].taskId, 'task_b')
  assert.equal(h.starts.length, 1)
})
