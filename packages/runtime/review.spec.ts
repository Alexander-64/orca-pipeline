import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RunStore } from './store'
import { LocalBackend } from './backend'
import { Coordinator } from '../core/coordinator'
import { parseScenario } from '../core/scenario'
import { reviewFromText, validateReview } from '../core/review'
import { ArtifactStore } from '../core/artifacts'
import { metricsForRuns } from '../core/metrics'

const fixture = fileURLToPath(new URL('./fixtures/review-executor.mjs', import.meta.url))
async function harness(t: { after(fn: () => Promise<void>): void }, mode = '', maxRepairs = 1, failure?: 'acceptance' | 'validation', blockReviewStartup = false) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-review-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const executor = { kind: 'jsonl' as const, executable: process.execPath, args: [fixture, mode] }
  class Backend extends LocalBackend {
    override async startWorker(...args: Parameters<LocalBackend['startWorker']>) {
      const [run, step, taskId] = args
      if (blockReviewStartup && step.role === 'evidence' && run.tasks[step.id].attempts.length === 1) {
        blockReviewStartup = false
        throw Object.assign(new Error('Agent startup blocked: agent-update-prompt'), { startOutcome: 'rejected', details: { result: { runId: run.runId, taskId, dispatchId: 'rejected-review-startup', state: 'failed', failedStage: 'agent_readiness' } } })
      }
      return super.startWorker(...args)
    }
  }
  const backend = new Backend(store, project, { executors: { author: executor, reviewer: executor, backup: executor } })
  const coordinator = new Coordinator({ client: backend, artifacts: new ArtifactStore(project), save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  t.after(async () => { for (const run of coordinator.list()) if (!['done', 'cancelled'].includes(run.status)) await coordinator.cancel(run.id); store.close(); await rm(project, { recursive: true, force: true }) })
  const source = parseScenario(`version: 2
name: review-test
objective: Verify independent repair and review
commandPolicy: {readOnly: false}
steps:
 - id: author
   title: Author
   spec: Create report.txt; final required content READY
   agent: author
   ${failure ? 'fallback: [backup]' : 'reviewAgent: reviewer'}
   maxRepairs: ${maxRepairs}
   acceptance: [${failure === 'acceptance' ? JSON.stringify(process.execPath + ' -e "process.exit(7)"') : 'pwd'}]
   ${failure === 'validation' ? 'outputSchema: {decision: {type: boolean}}' : ''}
`)
  const run = await coordinator.start({ id: 'folder:' + project, kind: 'folder', name: 'test', path: project, branch: null, hostId: null }, 'test', source)
  const deadline = Date.now() + 15000
  let paused = false
  while (!['done', 'failed', 'cancelled'].includes(run.status)) {
    assert.ok(Date.now() < deadline, JSON.stringify(run))
    const evidence = run.tasks['author-evidence']
    if (mode === 'pause-review' && !paused && evidence?.attempts.at(-1)?.status === 'running') { await coordinator.pause(run.id); paused = true }
    await new Promise(resolve => setTimeout(resolve, 25)); await coordinator.tick(run.id)
    if (paused && evidence?.repairPending) break
  }
  return { project, run, store, backend, coordinator }
}

test('review protocol validates canonical versioned verdicts without inferring prose', () => {
  assert.equal(reviewFromText('```json\n{"pipelineReview":{"version":1,"verdict":"BLOCKED","findings":"FIX-FIRST requires unavailable input"}}\n```').verdict, 'BLOCKED')
  for (const value of [{ version: 2, verdict: 'SHIP', findings: 'ok' }, { version: 1, verdict: 'PASS', findings: 'ok' }, { version: 1, verdict: 'SHIP', findings: '' }]) assert.throws(() => validateReview(value))
  assert.throws(() => reviewFromText('SHIP: looks fine'))
})

test('FIX-FIRST received during pause persists a pending repair and resumes without repeating review', async t => {
  const h = await harness(t, 'pause-review')
  assert.equal(h.run.status, 'paused')
  assert.equal(h.run.tasks['author-evidence'].repairPending, true)
  assert.equal(h.run.tasks['author-repair-1'], undefined)
  assert.equal(h.store.list('attempt:').length, 2)
  for (let i = 0; i < 3; i++) await h.coordinator.tick(h.run.id)
  assert.equal(h.store.list('attempt:').length, 2)
  const restored = new Coordinator({ client: h.backend, artifacts: new ArtifactStore(h.project), save: async run => h.store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  restored.restore([JSON.parse(JSON.stringify(h.run))]); await restored.resume(h.run.id)
  const deadline = Date.now() + 10000
  while (restored.get(h.run.id).status === 'running') { assert.ok(Date.now() < deadline); await restored.tick(h.run.id); await new Promise(resolve => setTimeout(resolve, 25)) }
  assert.equal(restored.get(h.run.id).status, 'done')
  assert.equal(h.store.list('attempt:').length, 4)
  assert.equal(restored.get(h.run.id).tasks['author-evidence'].attempts.length, 2)
})

test('post-repair reviewer startup rejection retries the same reviewer without fallback, including old snapshots', async t => {
  const h = await harness(t, '', 1, undefined, true)
  assert.equal(h.run.status, 'failed')
  assert.equal(h.run.tasks['author-repair-1'].status, 'done')
  assert.equal(h.run.tasks['author-evidence'].attempts.length, 1)
  assert.equal(h.run.tasks['author-evidence'].retrySameAgent, true)
  // Older snapshots lost this flag at startup failure. Recover it from the
  // completed repair, canonical verdict and rejected startup receipt.
  const snapshot = JSON.parse(JSON.stringify(h.run))
  delete snapshot.tasks['author-evidence'].retrySameAgent
  const restored = new Coordinator({ client: h.backend, artifacts: new ArtifactStore(h.project), save: async run => h.store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  restored.restore([snapshot]); await restored.retry(h.run.id)
  const deadline = Date.now() + 10000
  while (restored.get(h.run.id).status === 'running') { assert.ok(Date.now() < deadline); await restored.tick(h.run.id); await new Promise(resolve => setTimeout(resolve, 25)) }
  const run = restored.get(h.run.id)
  assert.equal(run.status, 'done')
  assert.deepEqual(run.tasks['author-evidence'].attempts.map(attempt => attempt.agent), ['reviewer', 'reviewer'])
  assert.equal(h.store.list('attempt:').length, 4)
})

test('semantic FIX-FIRST creates separate repair and fresh review with the latest repair context', async t => {
  const { run, project, store } = await harness(t)
  assert.equal(run.status, 'done')
  assert.equal(await readFile(join(project, 'report.txt'), 'utf8'), 'READY\n')
  const review = run.tasks['author-evidence']
  assert.deepEqual(review.attempts.map(attempt => attempt.review?.verdict), ['FIX-FIRST', 'SHIP'])
  assert.deepEqual(review.attempts.map(attempt => attempt.status), ['failed', 'done'])
  assert.equal(review.attempts[0].failure?.phase, 'review')
  assert.equal(run.tasks['author-repair-1'].status, 'done')
  assert.equal(store.list('attempt:').length, 4)
  assert.equal(metricsForRuns([run]).failovers, 0)
  const request = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', review.attempts[1].dispatchId, 'request.json'), 'utf8'))
  assert.match(request.prompt, /Repaired report.txt to READY/)
  assert.match(request.prompt, /Create report.txt; final required content READY/)
  for (const task of Object.values(run.tasks)) for (const attempt of task.attempts) assert.equal(attempt.checks?.[0].exitCode, 0)
})

test('repair limit creates distinct rounds and terminates without repeating repair 1', async t => {
  const { run, store } = await harness(t, 'always-fix', 2)
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.scenario.steps.filter(step => step.role === 'repair').map(step => step.id), ['author-repair-1', 'author-repair-2'])
  assert.equal(run.tasks['author-evidence'].attempts.length, 3)
  assert.equal(store.list('attempt:').length, 6)
  assert.match(run.tasks['author-evidence'].error!, /лимит исправлений/)
})

test('canonical BLOCKED does not create a repair even when findings mention FIX-FIRST', async t => {
  const { run, store } = await harness(t, 'blocked')
  assert.equal(run.status, 'failed'); assert.equal(store.list('attempt:').length, 2)
  assert.equal(run.tasks['author-evidence'].attempts[0].review?.verdict, 'BLOCKED')
  assert.equal(run.scenario.steps.filter(step => step.role === 'repair').length, 0)
})

for (const phase of ['acceptance', 'validation'] as const) test(`${phase} failure cannot trigger provider fallback from quota text in a successful report`, async t => {
  const { run, store, project } = await harness(t, 'quota-report', 1, phase)
  assert.equal(run.status, 'failed'); assert.equal(store.list('attempt:').length, 1)
  const attempt = run.tasks.author.attempts[0]
  assert.equal(attempt.failure?.phase, phase); assert.equal(attempt.failure?.kind, 'unknown')
  assert.match(attempt.output!, /quota exceeded/)
  const artifact = JSON.parse(await readFile(join(project, attempt.artifactPath!), 'utf8'))
  assert.equal(artifact.status, 'failed')
})
