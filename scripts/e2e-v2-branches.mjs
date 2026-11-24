// Explicit real-model E2E; uses only new temporary projects and existing Pi credentials.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
for (const decision of process.argv.includes('--pass-only') ? ['pass'] : ['improve', 'pass']) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-v2-' + decision + '-'))
  const call = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '-C', project, '--json'], { encoding: 'utf8', timeout: 30_000 })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
    return JSON.parse(result.stdout)
  }
  await writeFile(join(project, 'README.md'), `# Branch calibration fixture\nThe required calibration decision is ${decision}. This is test data, not a real quality assessment.\n`)
  await writeFile(join(project, 'plan.yaml'), `version: 2
name: real-branches-${decision}
objective: Verify actual model result routing in independent sessions
commandPolicy: {readOnly: true}
steps:
 - id: decide
   title: Read calibration fixture
   spec: Read README.md. Submit its exact calibration decision via submit_result. This is test data, not a quality assessment. Report under 80 words. No questions or changes.
   agent: pi
   acceptance: [pwd]
   outputSchema: {decision: {type: string, enum: [improve, pass]}}
 - id: improve
   title: Improve branch
   needs: [decide]
   when: {step: decide, field: decision, op: eq, value: improve}
   spec: Independently read README.md and verify the preceding decision/report agrees with its calibration value. Report under 80 words. No changes or questions.
   agent: pi
   acceptance: [pwd]
 - id: pass
   title: Pass branch
   needs: [decide]
   when: {step: decide, field: decision, op: eq, value: pass}
   spec: Independently read README.md and verify the preceding decision/report agrees with its calibration value. Report under 80 words. No changes or questions.
   agent: pi
   acceptance: [pwd]
 - id: summary
   title: Independent final review
   needs: [decide, improve, pass]
   join: all_settled
   spec: Independently review README.md and received predecessor statuses, data and reports. Identify the executed branch and the skipped branch by their IDs. Report under 100 words. No changes or questions.
   agent: pi
   acceptance: [pwd]
`)
  let run, finished = false
  try {
    run = call('run', '-f', 'plan.yaml')
    console.log(JSON.stringify({ project, runId: run.id, decision }))
    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const current = call('status', '--run', run.id).runs.find(item => item.id === run.id)
      if (!['done', 'failed', 'cancelled'].includes(current.status)) continue
      finished = true
      const evidenceFile = join(project, 'e2e-evidence.json')
      await writeFile(evidenceFile, JSON.stringify(current, null, 2), { mode: 0o600 })
      assert.equal(current.status, 'done')
      assert.deepEqual(current.tasks.decide.data, { decision })
      const other = decision === 'improve' ? 'pass' : 'improve'
      assert.equal(current.tasks[decision].status, 'done')
      assert.equal(current.tasks[other].status, 'skipped')
      assert.equal(current.tasks[other].attempts.length, 0)
      assert.equal(current.tasks.summary.status, 'done')
      const attempts = Object.values(current.tasks).flatMap(task => task.attempts)
      assert.equal(attempts.length, 3)
      const sessions = new Set()
      for (const attempt of attempts) {
        assert.equal(attempt.status, 'done')
        assert.ok(attempt.checks.length && attempt.checks.every(check => check.exitCode === 0))
        const receipt = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', attempt.dispatchId, 'result.json'), 'utf8'))
        sessions.add(receipt.sessionFile)
      }
      assert.equal(sessions.size, 3)
      const summary = current.tasks.summary.attempts[0]
      const request = JSON.parse(await readFile(join(project, '.agent-pipeline/runtime/attempts', summary.dispatchId, 'request.json'), 'utf8'))
      assert.ok(request.prompt.includes(`Predecessor ${other} (skipped)`))
      assert.ok(request.prompt.includes(`Validated data: {"decision":"${decision}"}`))
      const state = JSON.parse(await readFile(join(project, '.agent-pipeline/artifacts', current.runId, other + '.state.json'), 'utf8'))
      assert.equal(state.status, 'skipped'); assert.equal(state.artifacts.length, 0)
      console.log(JSON.stringify({ status: 'passed', decision, runId: current.id, evidenceFile, sessions: sessions.size }))
      break
    }
    assert.ok(finished, 'Observation deadline exceeded; temporary project retained')
  } finally {
    if (run && !finished) { try { call('stop', '--run', run.id) } catch (error) { console.error('Inspect test project: ' + error.message) } }
    try { call('shutdown') } catch (error) { console.error('Test supervisor retained: ' + error.message) }
  }
}
