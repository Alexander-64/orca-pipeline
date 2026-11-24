import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { GhPrClient, type PrClient, type PrStatus } from './pr'
import { parseScenario } from './scenario'

function prClient(states: string[][], headRefOid = 'head-1') {
  const calls: string[] = []
  const client: PrClient = {
    create: async () => {
      calls.push('create')
      return { url: 'https://example/pr/1', headRefOid, checks: states[0].map((state) => ({ name: 'test', state })) }
    },
    checks: async () => {
      calls.push('checks')
      const current = states.length > 1 ? states.shift()! : states[0]
      return { url: 'https://example/pr/1', headRefOid, checks: current.map((state) => ({ name: 'test', state })) }
    },
    merge: async (_url, expectedHead) => {
      if (expectedHead !== headRefOid) throw new Error('PR head изменился; merge остановлен')
      calls.push('merge')
    }
  }
  return { client, calls }
}

const oneStep = `  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`

test('creates a PR after DAG completion and waits for green checks', async () => {
  const pr = prClient([['pending'], ['success']])
  const h = coordinatorFixture({ pr: pr.client })
  const scenario = parseScenario(`name: pr
objective: pr
pullRequest: { base: main }
steps:
${oneStep}`)
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', scenario)
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'running')
  assert.equal(run.pr?.status, 'pending')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'done')
  assert.equal(run.pr?.status, 'approved')
  assert.ok(!pr.calls.includes('merge'))
})

for (const outcome of ['failure','cancel']) test('fails the run when a PR check reports ' + outcome, async () => {
  const pr = prClient([[outcome]])
  const h = coordinatorFixture({ pr: pr.client })
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: pr
objective: pr
pullRequest: { base: main }
steps:
${oneStep}`))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.pr?.status, 'failed')
})

test('merge waits for human approval and preserves the expected head', async () => {
  const pr = prClient([['success']])
  const h = coordinatorFixture({ pr: pr.client })
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: pr
objective: pr
pullRequest: { base: main, merge: true, mergeApproval: Merge approved? }
steps:
${oneStep}`))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  assert.equal(run.status, 'running')
  assert.ok(!pr.calls.includes('merge'))
  await h.coordinator.resolveGate(run.id, 'build', 'approve')
  assert.equal(run.pr?.status, 'merged')
  assert.ok(pr.calls.includes('merge'))
})

test('stops merge when the PR head changed', async () => {
  const pr = prClient([['success']])
  const h = coordinatorFixture({ pr: pr.client })
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: pr
objective: pr
pullRequest: { base: main, merge: true, mergeApproval: Merge approved? }
steps:
${oneStep}`))
  h.statuses.set('task_build', 'completed')
  await h.coordinator.tick(run.id)
  pr.client.checks = async () => ({ url: 'https://example/pr/1', headRefOid: 'head-2', checks: [{ name: 'test', state: 'success' }] })
  pr.client.merge = async () => { throw new Error('PR head изменился; merge остановлен') }
  await h.coordinator.resolveGate(run.id, 'build', 'approve')
  await h.coordinator.tick(run.id)
  assert.ok(!pr.calls.includes('merge'))
  assert.match(run.error ?? '', /head изменился/)
})

test('requires mergeApproval when merge is enabled', () => {
  assert.throws(() => parseScenario(`name: pr
objective: pr
pullRequest: { base: main, merge: true }
steps:
${oneStep}`), /mergeApproval/)
})


test('the GitHub merge command pins the approved commit even when the branch moves after inspection', async () => {
  const url = 'https://github.com/example/project/pull/7', head = 'a'.repeat(40)
  const calls: string[][] = []
  const client = new GhPrClient(async (_file, args) => {
    calls.push(args)
    if (args[1] === 'view') return { code:0, stdout:JSON.stringify({ url, headRefOid:head }), stderr:'' }
    if (args[1] === 'checks') return { code:0, stdout:'[{"name":"test","bucket":"pass"}]', stderr:'' }
    return { code:1, stdout:'', stderr:'head commit changed' }
  })
  await assert.rejects(client.merge(url, head), /head commit changed/)
  assert.deepEqual(calls.at(-1), ['pr','merge',url,'--merge','--match-head-commit',head])
})
