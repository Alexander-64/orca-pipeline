import { assert, test } from 'orca/testing'
import type { OrcaClient } from './cli'
import { fixtureWorkspace } from './coordinatorFixture'
import { Planner } from './planner'
import type { PlannerRun } from './types'

const yaml = `\`\`\`yaml
name: generated
objective: generated
steps:
  - id: check
    title: Check
    spec: Read only
    agent: codex
    acceptance: [pwd]
\`\`\``

function plannerFixture(initialStatus: string, output = yaml, result?: unknown) {
  const outputCalls: string[] = []
  let status = initialStatus
  const releases: string[] = []
  const posted: PlannerRun[] = []
  const client = {
    createRun: async () => 'run_plan',
    createTask: async () => 'task_plan',
    startWorker: async () => 'dispatch_plan',
    listTasks: async () => [{ id: 'task_plan', status, result }],
    workerOutput: async (id: string) => { outputCalls.push(id); return output },
    releaseWorker: async (id: string) => { releases.push(id) }
  } as unknown as OrcaClient
  const planner = new Planner({ client, notify: (plan) => posted.push(structuredClone(plan)) })
  return {
    planner,
    outputCalls,
    releases,
    posted,
    setStatus: (next: string) => { status = next }
  }
}

test('planner completion extracts YAML and releases the settled worker', async () => {
  const h = plannerFixture('dispatched')
  const plan = await h.planner.start(fixtureWorkspace, 'term_1', 'Составь read-only pipeline', 'codex')
  h.setStatus('completed')
  await h.planner.tick(plan.id)
  assert.equal(plan.status, 'done')
  assert.match(plan.source ?? '', /name: generated/)
  assert.deepEqual(h.releases, ['dispatch_plan'])
  assert.equal(h.posted.at(-1)?.status, 'done')
})

test('planner failure preserves provider output without inventing YAML', async () => {
  const h = plannerFixture('dispatched', 'Codex hit its usage limit')
  const plan = await h.planner.start(fixtureWorkspace, 'term_1', 'Составь pipeline', 'codex')
  h.setStatus('failed')
  await h.planner.tick(plan.id)
  assert.equal(plan.status, 'failed')
  assert.equal(plan.source, undefined)
  assert.match(plan.error ?? '', /usage limit/)
})

for (const [label, result] of [
  ['JSON string', JSON.stringify({ body: yaml })],
  ['object', { body: yaml }],
  ['nested object', { result: { body: yaml } }],
  ['nested JSON string', JSON.stringify({ result: JSON.stringify({ body: yaml }) })]
] as const) {
  test(`planner prefers ${label} task result over clipped transcript and releases once after recovery`, async () => {
    const h = plannerFixture('completed', yaml.slice(0, -3), result)
    const restored: PlannerRun = {
      id: 'restored', runId: 'run_plan', dispatchId: 'dispatch_plan',
      agent: 'codex', workspaceId: fixtureWorkspace.id, objective: 'Plan',
      createdAt: new Date().toISOString(), status: 'running'
    }
    h.planner.restore([restored])
    await Promise.all([h.planner.tick(restored.id), h.planner.tick(restored.id)])
    await h.planner.tick(restored.id)
    assert.equal(restored.status, 'done')
    assert.match(restored.source ?? '', /name: generated/)
    assert.deepEqual(h.outputCalls, [])
    assert.deepEqual(h.releases, ['dispatch_plan'])
    assert.equal(h.posted.length, 1)
  })
}

for (const [label, result] of [
  ['malformed JSON', '{broken'],
  ['missing body', { outcome: 'succeeded' }],
  ['non-string body', { body: 42 }],
  ['invalid YAML body', { body: '```yaml\nname: invalid\n```' }],
  ['truncated body', { body: yaml.slice(0, -3) }]
] as const) {
  test(`planner falls back to transcript for ${label}`, async () => {
    const h = plannerFixture('dispatched', yaml, result)
    const plan = await h.planner.start(fixtureWorkspace, 'term_1', 'Plan', 'codex')
    h.setStatus('completed')
    await h.planner.tick(plan.id)
    assert.equal(plan.status, 'done')
    assert.match(plan.source ?? '', /name: generated/)
    assert.deepEqual(h.outputCalls, ['dispatch_plan'])
    assert.deepEqual(h.releases, ['dispatch_plan'])
  })
}

test('planner reports a clipped transcript honestly when task result is unusable', async () => {
  const h = plannerFixture('dispatched', yaml.slice(0, -3), { body: null })
  const plan = await h.planner.start(fixtureWorkspace, 'term_1', 'Plan', 'codex')
  h.setStatus('completed')
  await h.planner.tick(plan.id)
  await h.planner.tick(plan.id)
  assert.equal(plan.status, 'failed')
  assert.equal(plan.source, undefined)
  assert.match(plan.error ?? '', /Planner returned no fenced YAML block/)
  assert.deepEqual(h.outputCalls, ['dispatch_plan'])
  assert.deepEqual(h.releases, [])
})
