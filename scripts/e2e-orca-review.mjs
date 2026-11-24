// Observe an explicitly started read-only calibration run. Only dismiss the
// verified Codex update menu in this run's exact project; never submit prompts.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [project, runId] = process.argv.slice(2)
assert.ok(project && runId, 'Pass project and Core run ID')
const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
const execute = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4000000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return JSON.parse(result.stdout)
}
const call = (...args) => execute(process.execPath, [cli, ...args, '-C', project, '--json'])
const orca = (...args) => execute('orca', [...args, '--json']).result
let previous = '', complete = false
const dismissed = new Set()
for (let i = 0; i < 160; i++) {
  const run = call('status', '--run', runId).runs.find(run => run.id === runId)
  assert.ok(run); assert.match(run.scenario.name, /^native-readonly-repair-review/)
  const state = JSON.stringify({ status: run.status, tasks: Object.values(run.tasks).map(task => ({ id: task.stepId, status: task.status, error: task.error, attempts: task.attempts.length })) })
  if (state !== previous) { console.log(state); previous = state }
  if (run.status === 'failed') {
    const failed = Object.values(run.tasks).filter(task => task.status === 'failed')
    for (const task of failed) {
      assert.match(task.error, /Agent startup blocked: agent-update-prompt/, 'Unexpected real failure; preserve the run for investigation')
      const handle = task.startup?.terminalHandle ?? task.pendingTerminalHandle
      assert.ok(handle && !dismissed.has(handle), 'Do not blindly repeat terminal input')
      const { terminal } = orca('terminal', 'show', '--terminal', handle)
      assert.equal(terminal.worktreePath, project); assert.equal(terminal.agentIdentity, 'codex')
      assert.equal(terminal.agentWait?.reason, 'agent-update-prompt')
      assert.match(terminal.preview, /esc skip/)
      orca('terminal', 'send', '--terminal', handle, '--text', '\x1b')
      dismissed.add(handle)
    }
    call('retry', '--run', runId)
  }
  if (run.status === 'done') {
    assert.deepEqual(run.tasks.author.data, { marker: 'DRAFT' })
    assert.deepEqual(run.tasks['author-repair-1'].data, { marker: 'READY' })
    const review = run.tasks['author-evidence']
    assert.deepEqual(review.attempts.map(attempt => attempt.review?.verdict), ['FIX-FIRST', 'SHIP'])
    assert.notEqual(review.attempts[0].dispatchId, review.attempts[1].dispatchId)
    const attempts = Object.values(run.tasks).flatMap(task => [...(task.history ?? []).flatMap(revision => revision.attempts), ...task.attempts])
    assert.equal(attempts.length, 4)
    assert.ok(attempts.filter(attempt => attempt.status === 'done').every(attempt => attempt.checks?.[0].exitCode === 0))
    const missingHistoricalRuntimeChecks = attempts.filter(attempt => !attempt.checks?.length).map(attempt => attempt.dispatchId)
    const nativeTasks = orca('orchestration', 'task-list', '--run', run.runId, '--full').tasks
    const nativeWorkers = attempts.map(attempt => orca('orchestration', 'worker-show', '--dispatch', attempt.dispatchId, '--full'))
    assert.equal(new Set(nativeWorkers.map(shown => shown.worker.agentTerminalHandle)).size, 4)
    const firstReviewWorker = nativeWorkers.find(shown => shown.dispatch.id === review.attempts[0].dispatchId)
    if (review.attempts[0].taskId === review.attempts[1].taskId) assert.equal(firstReviewWorker.worker.state, 'failed', 'Only a genuinely failed native Task can use retry-of')
    else {
      const firstReview = nativeTasks.find(task => task.id === review.attempts[0].taskId)
      assert.equal(JSON.parse(firstReview.result).outcome, firstReviewWorker.worker.state === 'succeeded' ? 'succeeded' : 'failed')
    }
    const evidenceFile = join(project, '.agent-pipeline', runId + '-native-review-evidence.json')
    await writeFile(evidenceFile, JSON.stringify({ run, nativeTasks, nativeWorkers, dismissedMenus: [...dismissed], missingHistoricalRuntimeChecks }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ status: 'passed', runId, nativeRun: run.runId, evidenceFile, missingHistoricalRuntimeChecks })); complete = true; break
  }
  await new Promise(resolve => setTimeout(resolve, 2000))
}
assert.ok(complete, 'Observation deadline reached; inspect this run before further actions')
