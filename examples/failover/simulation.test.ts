import { assert, test } from 'orca/testing'
import { simulateFailover } from './simulation'

test('simulated quota failover sends a checkpoint and gates downstream work on independent review', async () => {
  const result = await simulateFailover()
  assert.deepEqual(result.stops, ['dispatch_1'])
  assert.deepEqual(result.startsAfterFailover, [
    { taskId: 'task_build', agent: 'codex', retryOf: undefined },
    { taskId: 'task_build', agent: 'claude', retryOf: 'dispatch_1' }
  ])
  assert.equal(result.resumed.tasks.build.status, 'retrying')
  assert.equal(result.resumed.tasks.build.attempts[0].reason, 'quota')
  assert.match(result.checkpoint, /^Continuation checkpoint v1/)
  assert.match(result.checkpoint, /git diff --check/)
  assert.match(result.checkpoint, /Partial draft saved in CHANGELOG.md/)
  assert.deepEqual(result.startsDuringReview.slice(2), [
    { taskId: 'task_build-evidence', agent: 'kimi', retryOf: undefined }
  ])
  assert.equal(result.run.tasks['build-evidence'].status, 'done')
  assert.match(result.run.tasks['build-evidence'].attempts[0].output ?? '', /^SHIP:/)
  assert.equal(result.starts[3]?.taskId, 'task_prepare')
  assert.equal(result.run.status, 'done')

  console.log(['[Simulation] Codex quota error → Claude retry', result.checkpoint,
    'Kimi review → SHIP → downstream release summary → run done'].join('\n\n'))
})
