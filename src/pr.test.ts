import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import type { PrClient, PrStatus } from './pr'
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
      if (expectedHead !== headRefOid) throw new Error('The PR head changed. Merge stopped')
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

test('fails the run when PR checks are red', async () => {
  const pr = prClient([['failure']])
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
  pr.client.merge = async () => { throw new Error('The PR head changed. Merge stopped') }
  await h.coordinator.resolveGate(run.id, 'build', 'approve')
  await h.coordinator.tick(run.id)
  assert.ok(!pr.calls.includes('merge'))
  assert.match(run.error ?? '', /head changed/)
})

test('requires mergeApproval when merge is enabled', () => {
  assert.throws(() => parseScenario(`name: pr
objective: pr
pullRequest: { base: main, merge: true }
steps:
${oneStep}`), /mergeApproval/)
})
