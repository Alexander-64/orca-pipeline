// Real-model retry calibration in a disposable project; existing Pi credentials only.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
const project = await mkdtemp(join(tmpdir(), 'pipeline-pi-retry-'))
const call = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args, '-C', project, '--json'], { encoding: 'utf8', timeout: 30000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return JSON.parse(result.stdout)
}
await mkdir(join(project, '.agent-pipeline'))
await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { pi: { kind: 'pi' }, backup: { kind: 'pi' } } }))
await writeFile(join(project, 'README.md'), '# Retry calibration\nThe calibration decision is pass. Do not create or edit any files. The harness controls ready.flag to cause one acceptance failure, then enable the retry.\n')
const check = process.execPath + ' -e "process.exit(Number(!require(\'node:fs\').existsSync(\'ready.flag\')))"'
await writeFile(join(project, 'plan.yaml'), `version: 2
name: real-pi-retry
objective: Recompute a completed final report after upstream retry
commandPolicy: {readOnly: false}
steps:
 - id: decide
   title: Read calibration
   agent: pi
   fallback: [backup]
   spec: Read README.md and submit its exact decision via submit_result. Do not create ready.flag or change files. No questions. Return under 60 words.
   outputSchema: {decision: {type: string, enum: [pass]}}
   acceptance: [${JSON.stringify(check)}]
 - id: pass
   title: Pass branch
   agent: pi
   needs: [decide]
   when: {step: decide, field: decision, op: eq, value: pass}
   spec: Independently read README.md and confirm the received validated predecessor decision. No changes or questions. Report under 60 words.
   acceptance: [pwd]
 - id: summary
   title: Summarize actual inputs
   agent: pi
   needs: [decide, pass]
   join: all_settled
   spec: Read README.md and received actual predecessor statuses/reports. State whether decide and pass are done, failed or skipped. Do not infer success from an old checkpoint. No changes or questions. Under 80 words.
   acceptance: [pwd]
`)
let run, finished = false
async function settle() {
  for (let i = 0; i < 140; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const current = call('status', '--run', run.id).runs.find(item => item.id === run.id)
    if (['done', 'failed', 'cancelled'].includes(current.status)) return current
  }
  throw new Error('Observation deadline exceeded')
}
try {
  run = call('run', '-f', 'plan.yaml'); console.log(JSON.stringify({ project, runId: run.id }))
  const first = await settle()
  await writeFile(join(project, 'e2e-before.json'), JSON.stringify(first, null, 2), { mode: 0o600 })
  assert.equal(first.status, 'failed'); assert.equal(first.tasks.summary.status, 'done')
  assert.equal(first.tasks.decide.attempts.length, 1)
  assert.equal(first.tasks.decide.attempts[0].failure.phase, 'acceptance')
  assert.equal(first.tasks.pass.status, 'skipped')
  const old = first.tasks.summary.attempts[0]
  const oldReport = await readFile(join(project, old.artifactPath), 'utf8')
  await writeFile(join(project, 'ready.flag'), 'Harness enables retry\n')
  call('retry', '--run', run.id)
  const current = await settle(); finished = true
  const evidenceFile = join(project, 'e2e-evidence.json')
  await writeFile(evidenceFile, JSON.stringify(current, null, 2), { mode: 0o600 })
  assert.equal(current.status, 'done', JSON.stringify(current.tasks))
  assert.equal(current.tasks.pass.status, 'done')
  assert.equal(current.tasks.summary.revision, 1)
  assert.notEqual(current.tasks.summary.taskId, first.tasks.summary.taskId)
  assert.equal(current.tasks.summary.history[0].attempts[0].dispatchId, old.dispatchId)
  assert.equal(await readFile(join(project, old.artifactPath), 'utf8'), oldReport)
  const attempts = Object.values(current.tasks).flatMap(task => [...(task.history ?? []).flatMap(revision => revision.attempts), ...task.attempts])
  assert.equal(attempts.length, 5)
  const sessions = new Set()
  for (const attempt of attempts) {
    const receipt = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', attempt.dispatchId, 'result.json'), 'utf8'))
    sessions.add(receipt.sessionFile)
  }
  assert.equal(sessions.size, 5)
  const latest = current.tasks.summary.attempts[0]
  const request = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', latest.dispatchId, 'request.json'), 'utf8'))
  assert.ok(request.prompt.includes('Predecessor decide (done)')); assert.ok(request.prompt.includes('Predecessor pass (done)'))
  console.log(JSON.stringify({ status: 'passed', project, runId: run.id, sessions: sessions.size, evidenceFile }))
} finally {
  if (run && !finished) { try { call('stop', '--run', run.id) } catch (error) { console.error('Inspect temporary project: ' + error.message) } }
  try { call('shutdown') } catch (error) { console.error('Inspect supervisor: ' + error.message) }
}
