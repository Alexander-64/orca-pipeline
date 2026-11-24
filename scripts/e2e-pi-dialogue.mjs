// Explicit credential-dependent E2E. Runs only in a new temporary project.
// node scripts/e2e-pi-dialogue.mjs [--recover]
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const recover = process.argv.includes('--recover')
const project = await mkdtemp(join(tmpdir(), 'pipeline-pi-e2e-'))
const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
const raw = (...args) => spawnSync(process.execPath, [cli, ...args, '-C', project, '--json'], { encoding: 'utf8', timeout: 30_000 })
function call(...args) {
  const result = raw(...args)
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return JSON.parse(result.stdout)
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
await writeFile(join(project, 'README.md'), '# Pi interaction E2E\nTemporary read-only test project.\n')
await writeFile(join(project, 'plan.yaml'), `name: pi-interaction-e2e
objective: Verify live messages${recover ? ' and interrupted context recovery' : ''}
commandPolicy: {readOnly: true}
steps:
 - id: dialogue
   title: Dialogue
   agent: pi
   spec: >-
     First call ask_user and ask which identifier to remember. Do not answer it yourself.
     Retain the identifier from the answer; never ask for it again if it is already in session history.
     ${recover ? 'Then call ask_user to ask Ready to finish? Wait for its answer. On session recovery re-ask only that second question if it was still unanswered.' : ''}
     Read README.md. Return a complete report under 120 words, repeating the identifier exactly and
     any marker requested by a live Pipeline user message. No file changes.
   acceptance: [pwd]
`)
let run, finished = false
try {
  run = call('run', '-f', 'plan.yaml')
  console.log(JSON.stringify({ project, runId: run.id, recover }))
  let firstAnswer = false, killedQuestion, sessionBefore, pidBefore, replacementAnswered = false
  for (let i = 0; i < 120; i++) {
    await delay(1500)
    const current = call('status', '--run', run.id).runs.find(item => item.id === run.id)
    const task = current.tasks.dialogue
    const question = task.questions?.find(item => item.state === 'waiting' && item.id !== killedQuestion)
    if (question && !firstAnswer) {
      assert.notEqual(raw('recover', '--run', run.id, '--step', 'dialogue').status, 0, 'Live worker must not be replaced')
      call('send', '--run', run.id, '--step', 'dialogue', '--message-id', 'guidance', '--text', 'Include this exact marker in your final report: PIPELINE_STEER_7C2A')
      call('answer', '--run', run.id, '--step', 'dialogue', '--question', question.id, '--message-id', 'answer-first', '--text', 'PIPELINE_MEMORY_D8A72F')
      firstAnswer = true
    } else if (question && recover && !killedQuestion) {
      const id = task.attempts.at(-1).dispatchId
      const directory = join(project, '.agent-pipeline/runtime/attempts', id)
      const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8'))
      assert.equal(started.id, id)
      sessionBefore = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).file
      pidBefore = started.pid
      // This process belongs exclusively to the temporary project created above.
      process.kill(pidBefore, 'SIGKILL')
      for (let j = 0; j < 40; j++) {
        let exited = false
        try { process.kill(pidBefore, 0) } catch (error) { if (error.code === 'ESRCH') exited = true; else throw error }
        if (exited) break
        await delay(100)
      }
      call('recover', '--run', run.id, '--step', 'dialogue')
      killedQuestion = question.id
      console.log(JSON.stringify({ recoveredAttempt: id, exitedPid: pidBefore }))
    } else if (question && killedQuestion && !replacementAnswered) {
      call('answer', '--run', run.id, '--step', 'dialogue', '--question', question.id, '--message-id', 'answer-second', '--text', 'Yes, finish now.')
      replacementAnswered = true
    }
    if (['done', 'failed', 'cancelled'].includes(current.status)) {
      finished = true
      const id = task.attempts.at(-1).dispatchId
      const directory = join(project, '.agent-pipeline/runtime/attempts', id)
      const sessionAfter = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).file
      const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8'))
      const evidence = { project, run: current, recover, sessionBefore, sessionAfter, pidBefore, pidAfter: started.pid, generation: started.generation }
      const evidenceFile = join(project, 'e2e-evidence.json')
      await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 })
      assert.equal(current.status, 'done')
      assert.equal(task.attempts.length, 1)
      assert.match(task.attempts[0].output, /PIPELINE_MEMORY_D8A72F/)
      assert.match(task.attempts[0].output, /PIPELINE_STEER_7C2A/)
      for (const id of ['guidance', 'answer-first', ...(recover ? ['answer-second'] : [])]) assert.ok(task.messages.some(message => message.id === id && message.state === 'delivered'), 'Missing delivery receipt: ' + id)
      if (recover) { assert.equal(sessionAfter, sessionBefore); assert.equal(started.generation, 1); assert.notEqual(started.pid, pidBefore); assert.ok(replacementAnswered) }
      console.log(JSON.stringify({ status: 'passed', runId: run.id, evidenceFile }))
      break
    }
  }
  assert.ok(finished, 'Observation deadline exceeded; test project retained for inspection')
} finally {
  if (run && !finished) { try { call('stop', '--run', run.id) } catch (error) { console.error('Test cleanup needs inspection: ' + error.message) } }
  try { call('shutdown') } catch (error) { console.error('Test supervisor retained: ' + error.message) }
}
