// Real-model calibration. Writes only to a new temporary project; uses existing Pi credentials.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
const project = await mkdtemp(join(tmpdir(), 'pipeline-pi-review-'))
const call = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args, '-C', project, '--json'], { encoding: 'utf8', timeout: 30000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return JSON.parse(result.stdout)
}
await mkdir(join(project, '.agent-pipeline'))
await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { author: { kind: 'pi' }, reviewer: { kind: 'pi' } } }))
await writeFile(join(project, 'README.md'), '# Repair calibration\nFinal report.txt must contain exactly READY followed by a newline. The initial author deliberately writes DRAFT to test the review cycle. A separate repair must replace DRAFT with READY. Reviewers inspect files, never edit. No external input is needed.\n')
await writeFile(join(project, 'plan.yaml'), `version: 2
name: real-pi-repair-review
objective: Prove independent review, separate repair and fresh re-review
commandPolicy: {readOnly: false}
steps:
 - id: author
   title: Author calibration report
   spec: Read README.md. On INITIAL execution only, deliberately write report.txt containing DRAFT and a newline using write_file. This intentional fixture defect must be caught by the reviewer. If executing a repair task, correct the file to exactly READY and a newline, overriding the initial DRAFT instruction. Do not ask questions. Return a concise report under 80 words.
   agent: author
   reviewAgent: reviewer
   maxRepairs: 1
   acceptance: [pwd]
`)
let run, finished = false
try {
  run = call('run', '-f', 'plan.yaml')
  console.log(JSON.stringify({ project, runId: run.id }))
  for (let i = 0; i < 180; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const current = call('status', '--run', run.id).runs.find(item => item.id === run.id)
    if (!['done', 'failed', 'cancelled'].includes(current.status)) continue
    finished = true
    const evidenceFile = join(project, 'e2e-evidence.json')
    await writeFile(evidenceFile, JSON.stringify(current, null, 2), { mode: 0o600 })
    assert.equal(current.status, 'done', JSON.stringify(current.tasks))
    assert.equal(await readFile(join(project, 'report.txt'), 'utf8'), 'READY\n')
    const evidence = current.tasks['author-evidence']
    assert.deepEqual(evidence.attempts.map(attempt => attempt.review?.verdict), ['FIX-FIRST', 'SHIP'])
    assert.equal(current.tasks['author-repair-1'].status, 'done')
    const attempts = Object.values(current.tasks).flatMap(task => task.attempts)
    assert.equal(attempts.length, 4)
    const sessions = new Set()
    for (const attempt of attempts) {
      assert.ok(attempt.checks.length && attempt.checks.every(check => check.exitCode === 0))
      const receipt = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', attempt.dispatchId, 'result.json'), 'utf8'))
      assert.ok(receipt.sessionFile); sessions.add(receipt.sessionFile)
      if (attempt.agent === 'reviewer') {
        assert.deepEqual(receipt.filesModified, []); assert.deepEqual(receipt.uncertainFiles, [])
        const messages = (await readFile(receipt.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        const calls = messages.flatMap(entry => entry.message?.role === 'assistant' ? entry.message.content.filter(item => item.type === 'toolCall') : [])
        assert.ok(calls.some(call => call.name === 'submit_review'))
        assert.ok(!calls.some(call => call.name === 'write_file'))
      } else assert.deepEqual(receipt.filesModified, ['report.txt'])
      const artifact = JSON.parse(await readFile(join(project, attempt.artifactPath), 'utf8'))
      assert.equal(artifact.status, attempt.status)
      assert.equal(artifact.filesModifiedKnown, true)
    }
    assert.equal(sessions.size, 4)
    const second = evidence.attempts[1]
    const request = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', second.dispatchId, 'request.json'), 'utf8'))
    assert.ok(request.prompt.includes('author-repair-1'))
    console.log(JSON.stringify({ status: 'passed', runId: run.id, project, evidenceFile, sessions: sessions.size }))
    break
  }
  assert.ok(finished, 'Observation deadline exceeded; project retained')
} finally {
  if (run && !finished) { try { call('stop', '--run', run.id) } catch (error) { console.error('Inspect test project: ' + error.message) } }
  try { call('shutdown') } catch (error) { console.error('Test supervisor retained: ' + error.message) }
}
