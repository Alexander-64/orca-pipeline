import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { handoffFor, redactSecrets } from './failover'
import { parseScenario } from './scenario'
import type { Attempt } from './types'

const step = parseScenario(`name: handoff
objective: handoff
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [pnpm test, pnpm lint]
`).steps[0]

test('redacts bearer tokens, provider keys and named secrets', () => {
  const output = redactSecrets('Bearer abc.def.ghi api_key=very-secret password: hidden ghp_123456789')
  assert.ok(!/abc\.def|very-secret|hidden|ghp_123456789/.test(output))
  assert.match(output, /\[REDACTED\]/)
})

test('includes files, check exit codes and acceptance in a versioned checkpoint', () => {
  const attempts: Attempt[] = [{
    dispatchId: 'd1',
    agent: 'codex',
    status: 'failed',
    startedAt: 'start',
    finishedAt: 'finish',
    filesModified: ['src/a.ts', 'src/a.test.ts'],
    checks: [{ command: 'pnpm test', exitCode: 1 }],
    output: 'Tests failed'
  }]
  const source = handoffFor(step, attempts)
  assert.match(source, /Continuation checkpoint v1/)
  assert.match(source, /src\/a\.ts/)
  assert.match(source, /pnpm test → 1/)
  assert.match(source, /pnpm lint/)
})

test('bounds oversized handoff output', () => {
  const attempts: Attempt[] = [{
    dispatchId: 'd1',
    agent: 'codex',
    status: 'failed',
    startedAt: 'start',
    output: 'x'.repeat(30_000)
  }]
  assert.ok(handoffFor(step, attempts).length <= 12_000)
})

test('redacts secrets inside previous attempt output', () => {
  const attempts: Attempt[] = [{
    dispatchId: 'd1',
    agent: 'codex',
    status: 'failed',
    startedAt: 'start',
    output: 'Authorization: Bearer super-secret-token'
  }]
  assert.ok(!/super-secret-token/.test(handoffFor(step, attempts)))
})

test('captures filesModified from the native worker_done result', async () => {
  const h = coordinatorFixture()
  const originalList = h.client.listTasks
  h.client.listTasks = async () => (await originalList('run_1')).map((task) => ({
    ...task,
    result: JSON.stringify({ filesModified: ['src/evidence.ts'] })
  }))
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: files
objective: files
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.deepEqual(run.tasks.build.attempts[0].filesModified, ['src/evidence.ts'])
})
