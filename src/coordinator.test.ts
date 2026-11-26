import { assert, test } from 'orca/testing'
import type { OrcaClient } from './cli'
import type { BeadsClient } from './beads'
import { Coordinator } from './coordinator'
import { parseScenario } from './scenario'
import type { PipelineRun, Workspace } from './types'

const scenario = parseScenario(`name: test
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude]
    acceptance: [test]
`)
const workspace: Workspace = { id: 'w1', kind: 'worktree', name: 'test', path: '/work', branch: 'main', hostId: null }

function harness(startError?: string) {
  const statuses = new Map<string, string>()
  const activity = { done: false }
  const starts: { agent: string; retryOf?: string }[] = []
  const handoffs: string[] = []
  const calls: string[] = []
  let sequence = 0
  const client = {
    createRun: async () => 'run_1',
    bindRun: async () => undefined,
    createTask: async (_run: string, _handle: string, step: { id: string }) => {
      statuses.set(`task_${step.id}`, 'ready')
      return `task_${step.id}`
    },
    listTasks: async () => [...statuses].map(([id, status]) => ({ id, status })),
    startWorker: async (_run: unknown, _step: unknown, _task: string, agent: string, retryOf?: string) => {
      calls.push('start')
      if (startError) throw new Error(startError)
      starts.push({ agent, retryOf })
      sequence += 1
      statuses.set('task_build', 'dispatched')
      return `dispatch_${sequence}`
    },
    sendWorker: async (_id: string, _subject: string, body: string) => {
      calls.push('handoff')
      handoffs.push(body)
    },
    workerOutput: async () => 'usage limit reached; partial work saved',
    workerActivityDone: async () => activity.done,
    releaseWorker: async () => undefined,
    stopWorker: async () => { calls.push('stop') }
  } as unknown as OrcaClient
  const beads = {
    create: async (_run: string, step: { id: string }) => `bd_${step.id}`,
    sync: async () => undefined,
    list: async () => [],
    comment: async () => undefined
  } as unknown as BeadsClient
  const saves: PipelineRun[] = []
  const coordinator = new Coordinator({
    client,
    beadsFor: () => beads,
    save: async (run) => { saves.push(structuredClone(run)) },
    notify: () => undefined,
    log: () => undefined
  })
  return { coordinator, statuses, starts, handoffs, calls, saves, activity }
}

test('continues a failed quota attempt on the next agent and finishes', async () => {
  const h = harness()
  const run = await h.coordinator.start(workspace, 'term_1', scenario)
  assert.deepEqual(h.starts, [{ agent: 'codex', retryOf: undefined }])
  assert.equal(run.tasks.beadId, undefined)
  assert.equal(run.tasks.build.beadId, 'bd_build')

  h.statuses.set('task_build', 'failed')
  await h.coordinator.tick(run.id)
  assert.deepEqual(h.starts[1], { agent: 'claude', retryOf: 'dispatch_1' })
  assert.equal(h.handoffs.length, 1)
  assert.match(h.handoffs[0], /partial work saved/)
  assert.equal(run.tasks.build.attempts[1].checkpointPreview, h.handoffs[0].slice(-4000))

  h.statuses.set('task_build', 'running')
  await h.coordinator.tick(run.id)
  assert.equal(run.tasks.build.status, 'running')
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'done')
  assert.equal(run.tasks.build.attempts.length, 2)
  assert.ok(h.saves.length > 0)
})

test('does not retry an ambiguous start or failover an ordinary failure', async () => {
  const failingStart = harness('connection lost')
  const failedRun = await failingStart.coordinator.start(workspace, 'term_1', scenario)
  assert.equal(failedRun.status, 'failed')
  assert.equal(failedRun.tasks.build.status, 'failed')
  await failingStart.coordinator.tick(failedRun.id)
  assert.equal(failingStart.calls.filter((call) => call === 'start').length, 1)

  const h = harness()
  const run = await h.coordinator.start(workspace, 'term_1', scenario)
  h.statuses.set('task_build', 'failed')
  const client = (h.coordinator as unknown as { deps: { client: OrcaClient } }).deps.client
  client.workerOutput = async () => 'tests failed'
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 1)
})

test('fails over a live dispatch only after the limited agent turn is done', async () => {
  const h = harness()
  const run = await h.coordinator.start(workspace, 'term_1', scenario)
  assert.equal(h.starts.length, 1)
  h.activity.done = true
  await h.coordinator.tick(run.id)
  assert.deepEqual(h.calls.slice(0, 4), ['start', 'stop', 'start', 'handoff'])
  assert.deepEqual(h.starts[1], { agent: 'claude', retryOf: 'dispatch_1' })
})

test('retry resumes a failed run on the remaining fallback task', async () => {
  const chained = parseScenario(`name: test
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude, kimi]
    acceptance: [test]
`)
  const h = harness()
  const run = await h.coordinator.start(workspace, 'term_1', chained)
  h.statuses.set('task_build', 'failed')
  await h.coordinator.tick(run.id)
  run.status = 'failed'
  run.tasks.build.status = 'failed'
  run.tasks.build.attempts.at(-1)!.status = 'failed'
  await h.coordinator.retry(run.id)
  assert.deepEqual(h.starts[2], { agent: 'kimi', retryOf: 'dispatch_2' })
})

test('manual switch fences the old dispatch before starting the replacement', async () => {
  const h = harness()
  const run = await h.coordinator.start(workspace, 'term_1', scenario)
  await h.coordinator.switchAgent(run.id, 'build')
  assert.deepEqual(h.calls.slice(0, 4), ['start', 'stop', 'start', 'handoff'])
  assert.deepEqual(h.starts[1], { agent: 'claude', retryOf: 'dispatch_1' })
})
