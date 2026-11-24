import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

const source = `name: gate
objective: gate
steps:
  - id: deploy
    title: Deploy
    spec: Deploy
    agent: codex
    approval: Разрешить read-only remote smoke?
    acceptance: [pwd]
`

test('approval gate blocks dispatch until approve and is not recreated', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(source))
  assert.equal(h.starts.length, 0)
  assert.equal(run.tasks.deploy.status, 'blocked')
  assert.ok(run.tasks.deploy.gateId)
  await h.coordinator.tick(run.id)
  assert.equal(h.gates.size, 1)
  await h.coordinator.resolveGate(run.id, 'deploy', 'approve')
  assert.equal(h.starts.length, 1)
  assert.equal(run.tasks.deploy.status, 'running')
})

test('rejected gate fails the step without a worker', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(source))
  await h.coordinator.resolveGate(run.id, 'deploy', 'reject')
  assert.equal(run.status, 'failed')
  assert.equal(h.starts.length, 0)
  assert.match(run.tasks.deploy.error ?? '', /отклонил/)
})

test('approval field survives repeated task polling', async () => {
  const h = coordinatorFixture()
  const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(source))
  const first = run.tasks.deploy.gateId
  await h.coordinator.tick(run.id)
  await h.coordinator.tick(run.id)
  assert.equal(run.tasks.deploy.gateId, first)
  assert.equal(h.starts.length, 0)
})
