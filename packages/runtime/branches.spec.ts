import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunStore } from './store'
import { LocalBackend } from './backend'
import { Coordinator } from '../core/coordinator'
import { parseScenario } from '../core/scenario'
import { ArtifactStore } from '../core/artifacts'
import type { PipelineRun } from '../core/types'

const fixture = fileURLToPath(new URL('./fixtures/branch-executor.mjs', import.meta.url))
const source = `version: 2
name: runtime-branches
objective: Test validated routing
commandPolicy: {readOnly: true}
steps:
 - {id: decide, title: Decide, spec: Decide, agent: fixture, acceptance: [pwd], outputSchema: {decision: {type: string, enum: [improve, pass]}}}
 - {id: improve, title: Improve, spec: Improve, agent: fixture, acceptance: [pwd], needs: [decide], when: {step: decide, field: decision, op: eq, value: improve}}
 - {id: pass, title: Pass, spec: Pass, agent: fixture, acceptance: [pwd], needs: [decide], when: {step: decide, field: decision, op: eq, value: pass}}
 - {id: summary, title: Summary, spec: Summarize actual statuses, agent: fixture, acceptance: [pwd], needs: [improve, pass], join: all_settled}
`
async function harness(t: { after(fn: () => Promise<void>): void }, decision: string, yaml = source, blockStartup = false, crashRevision = false) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-branches-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  class Backend extends LocalBackend {
    override async reviseTask(...args: Parameters<LocalBackend['reviseTask']>) {
      const id = await super.reviseTask(...args)
      if (crashRevision) { crashRevision = false; throw new Error('Injected revision receipt gap') }
      return id
    }
    private blocked = new Set(blockStartup ? ['decide', 'summary'] : [])
    override async startWorker(...args: Parameters<LocalBackend['startWorker']>) {
      if (this.blocked.delete(args[1].id)) throw new Error('Verified startup failure before worker creation')
      return super.startWorker(...args)
    }
  }
  const backend = new Backend(store, project, { executors: { fixture: { kind: 'jsonl', executable: process.execPath, args: [fixture, decision] }, backup: { kind: 'jsonl', executable: process.execPath, args: [fixture, 'pass'] } } })
  let coordinator = new Coordinator({ client: backend, artifacts: new ArtifactStore(project), save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  t.after(async () => { for (const run of coordinator.list()) if (['running', 'paused'].includes(run.status)) await coordinator.cancel(run.id); store.close(); await rm(project, { recursive: true, force: true }) })
  const run = await coordinator.start({ id: 'folder:' + project, kind: 'folder', name: 'Test', path: project, branch: null, hostId: null }, 'owner', parseScenario(yaml))
  const finish = async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      await coordinator.tick(run.id)
      const current = coordinator.get(run.id)
      if (['done', 'failed'].includes(current.status)) return current
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Branches did not settle: ' + JSON.stringify(coordinator.get(run.id)))
  }
  const restore = () => {
    coordinator = new Coordinator({ client: backend, artifacts: new ArtifactStore(project), save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
    coordinator.restore([store.get<PipelineRun>('run:' + run.id)!])
    return coordinator
  }
  return { run, backend, store, coordinator, finish, restore, project }
}

for (const crashRevision of [false, true]) test(`retry recomputes a completed finalizer from new inputs and preserves its prior result${crashRevision ? ' across a revision receipt gap' : ''}`, async t => {
  const h = await harness(t, 'invalid', source.replace('title: Decide,', 'title: Decide, fallback: [backup],'), false, crashRevision)
  const initial = await h.finish()
  assert.equal(initial.status, 'failed'); assert.equal(initial.tasks.summary.status, 'done')
  const oldTaskId = initial.tasks.summary.taskId
  const oldAttempt = JSON.parse(JSON.stringify(initial.tasks.summary.attempts[0]))
  const oldArtifact = await readFile(join(h.project, oldAttempt.artifactPath!), 'utf8')
  let coordinator = h.coordinator
  if (crashRevision) {
    await assert.rejects(coordinator.retry(initial.id), /revision receipt gap/)
    assert.equal(initial.status, 'paused'); assert.ok(initial.tasks.improve.revisionPending)
    const snapshot = h.store.get<PipelineRun>('run:' + initial.id)!
    await h.backend.reconcile(snapshot)
    coordinator = h.restore()
    await coordinator.resume(initial.id)
  } else await coordinator.retry(initial.id)
  const final = await h.finish()
  assert.equal(final.status, 'done')
  assert.deepEqual(final.tasks.decide.attempts.map(attempt => attempt.agent), ['fixture', 'backup'])
  assert.equal(final.tasks.pass.status, 'done'); assert.equal(final.tasks.improve.status, 'skipped')
  assert.equal(final.tasks.summary.revision, 1)
  assert.notEqual(final.tasks.summary.taskId, oldTaskId)
  assert.equal(final.tasks.summary.attempts.length, 1)
  assert.equal(final.tasks.summary.history?.[0].taskId, oldTaskId)
  assert.deepEqual(JSON.parse(JSON.stringify(final.tasks.summary.history?.[0].attempts[0])), oldAttempt)
  assert.equal(await readFile(join(h.project, oldAttempt.artifactPath!), 'utf8'), oldArtifact)
  assert.match(final.tasks.summary.attempts[0].output!, /Predecessor pass \(done\)/)
  assert.doesNotMatch(final.tasks.summary.attempts[0].output!, /Predecessor pass \(skipped\)/)
  assert.equal(h.store.list('attempt:').length, 5)
  assert.equal(h.store.list('task:').length, 7)
})

for (const decision of ['improve', 'pass']) test(`validated ${decision} result starts only its matching branch and joins skipped input`, async t => {
  const h = await harness(t, decision)
  const run = await h.finish(), other = decision === 'improve' ? 'pass' : 'improve'
  assert.equal(run.status, 'done')
  assert.deepEqual(run.tasks.decide.data, { decision })
  assert.deepEqual(run.tasks.decide.attempts[0].data, { decision })
  assert.equal(run.tasks[decision].status, 'done')
  assert.equal(run.tasks[other].status, 'skipped')
  assert.equal(run.tasks[other].attempts.length, 0)
  assert.match(run.tasks[other].skipReason!, /false/)
  assert.equal(run.tasks.summary.status, 'done')
  assert.match(run.tasks.summary.attempts[0].output!, /\(skipped\)/)
  assert.equal(h.store.list('attempt:').length, 3)
})

test('invalid result data fails the producer, skips default descendants and still runs all_settled finalizer', async t => {
  const h = await harness(t, 'invalid-decision')
  const run = await h.finish()
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.decide.status, 'failed')
  assert.equal(run.tasks.decide.data, undefined)
  assert.equal(run.tasks.improve.status, 'skipped'); assert.equal(run.tasks.pass.status, 'skipped')
  assert.equal(run.tasks.summary.status, 'done')
  assert.match(run.tasks.decide.attempts[0].output!, /Invalid result field/)
})

test('acceptance failure keeps validated candidate data from routing into a success branch', async t => {
  const yaml = source.replace('commandPolicy: {readOnly: true}', 'commandPolicy: {readOnly: false}').replace('acceptance: [pwd], outputSchema', `acceptance: [${JSON.stringify(process.execPath + ' -e "process.exit(7)"')}], outputSchema`)
  const h = await harness(t, 'improve', yaml)
  const run = await h.finish()
  assert.equal(run.status, 'failed')
  assert.equal(run.tasks.decide.data, undefined)
  assert.equal(run.tasks.improve.attempts.length, 0)
  assert.equal(run.tasks.decide.attempts[0].checks?.[0].exitCode, 7)
  assert.equal(run.tasks.summary.status, 'done')
})

test('pause prevents conditional starts; persisted typed data resumes without another producer', async t => {
  const h = await harness(t, 'improve')
  await h.coordinator.pause(h.run.id)
  for (let i = 0; i < 100 && h.run.tasks.decide.status !== 'done'; i++) { await new Promise(resolve => setTimeout(resolve, 25)); await h.coordinator.tick(h.run.id) }
  assert.equal(h.run.tasks.decide.status, 'done')
  assert.equal(h.run.tasks.improve.attempts.length, 0)
  const restored = h.restore()
  assert.deepEqual(restored.get(h.run.id).tasks.decide.data, { decision: 'improve' })
  await restored.resume(h.run.id)
  const run = await h.finish()
  assert.equal(run.status, 'done')
  assert.equal(run.tasks.decide.attempts.length, 1)
})

test('an unconfirmed startup pauses v2 without skipping its branches or starting the all_settled finalizer', async t => {
  const store = new RunStore(':memory:'); t.after(async () => store.close())
  let starts = 0
  class UnknownStart extends LocalBackend {
    override async preflightScenario() {}
    override async startWorker(): Promise<string> { starts++; throw Object.assign(new Error('Transport lost after request acceptance'), { startOutcome: 'unknown' }) }
  }
  const backend = new UnknownStart(store, '/tmp', { executors: { fixture: { kind: 'jsonl', executable: process.execPath } } })
  const coordinator = new Coordinator({ client: backend, save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  const run = await coordinator.start({ id: 'test', kind: 'folder', name: 'Test', path: '/tmp', branch: null, hostId: null }, 'owner', parseScenario(source))
  assert.equal(run.status, 'paused'); assert.equal(run.tasks.decide.unconfirmedStart, true)
  for (let i = 0; i < 3; i++) await coordinator.tick(run.id)
  assert.equal(starts, 1)
  for (const id of ['improve', 'pass', 'summary']) { assert.equal(run.tasks[id].status, 'pending'); assert.equal(run.tasks[id].attempts.length, 0) }
  await assert.rejects(coordinator.resume(run.id), /remains unknown/)
  await assert.rejects(coordinator.cancel(run.id), /before cancellation/)
  assert.equal(run.status, 'paused'); assert.equal(starts, 1)
})

test('v2 retries re-evaluate skipped branches and wait for dependencies before retrying the finalizer', async t => {
  const h = await harness(t, 'pass', source, true)
  const first = await h.finish()
  assert.equal(first.status, 'failed')
  assert.equal(first.tasks.decide.attempts.length, 0)
  assert.equal(first.tasks.summary.attempts.length, 0)
  assert.equal(first.tasks.pass.status, 'skipped')
  await h.coordinator.retry(first.id)
  assert.equal(h.coordinator.get(first.id).tasks.summary.attempts.length, 0)
  const result = await h.finish()
  assert.equal(result.status, 'done')
  assert.equal(result.tasks.pass.status, 'done')
  assert.equal(result.tasks.improve.status, 'skipped')
  assert.equal(result.tasks.decide.attempts.length, 1)
  assert.equal(result.tasks.summary.attempts.length, 1)
  assert.match(result.tasks.summary.attempts[0].output!, /Predecessor pass \(done\)/)
})
