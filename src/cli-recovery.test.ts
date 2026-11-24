import { createHash } from 'node:crypto'
import { assert, test } from 'orca/testing'
import { OrcaClient, type CommandResult } from './cli'
import { MemoryMutationJournal } from './mutations'
import { demoRun } from './testData'

const result = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result: value }), stderr: '' })
function fixture(suffix = '') {
  const run = structuredClone(demoRun)
  run.id += suffix; run.runId += suffix; run.tasks.build.taskId += suffix
  run.status = 'paused'
  run.tasks.build.status = 'blocked'; run.tasks.build.attempts = []; run.tasks.build.unconfirmedStart = true
  run.tasks.build.error = 'Agent codex is disabled. Choose an enabled agent.'
  const entry = {
    requestId: 'pipeline-launch-' + createHash('sha256').update(JSON.stringify([run.runId, run.tasks.build.taskId, null, 'codex'])).digest('hex').slice(0, 32),
    args: ['agent', 'launch', '--agent', 'codex', '--worktree', `path:${run.workspacePath}`, '--surface', 'terminal'], status: 'pending' as const
  }
  return { run, entry }
}

test('explicit recovery retires a launch-only receipt only after the native task is confirmed ready', async () => {
  const { run, entry } = fixture(), journal = new MemoryMutationJournal()
  await journal.put(entry)
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    if (args[1] === 'worker-list') return result({ workers: [] })
    if (args[1] === 'task-list') return result({ tasks: [{ id: run.tasks.build.taskId, status: 'ready' }] })
    throw new Error('Unexpected mutation')
  }, 'orca', journal)
  await assert.rejects(() => client.recoverPending(), /unconfirmed receipt/)
  const notes = await client.repairPendingLaunches([run])
  assert.ok(notes.length)
  assert.equal(run.tasks.build.unconfirmedStart, undefined)
  assert.equal(run.tasks.build.status, 'failed')
  assert.equal(run.tasks.build.error, 'Agent codex is disabled. Choose an enabled agent.')
  assert.equal((await journal.list())[0].status, 'failed')
  assert.ok(calls.every(args => ['worker-list', 'task-list'].includes(args[1])))
  // Receipt persisted before the run snapshot: a restart can reconstruct the transition.
  run.tasks.build.unconfirmedStart = true; run.tasks.build.status = 'blocked'
  await client.repairPendingLaunches([run])
  assert.equal(run.tasks.build.status, 'failed')
})

test('explicit recovery adopts an accepted exact dispatch without starting another worker', async () => {
  const { run, entry } = fixture(), journal = new MemoryMutationJournal()
  await journal.put(entry)
  const client = new OrcaClient(async (_file, args) => {
    if (args[1] === 'worker-list') return result({ workers: [{ taskId: run.tasks.build.taskId, dispatchId: 'dispatch-restored', projection: { provider: { id: 'codex', model: 'model' } } }] })
    if (args[1] === 'worker-show') return result({ dispatch: { id: 'dispatch-restored', runId: run.runId, taskId: run.tasks.build.taskId }, worker: { effects: [{ kind: 'dispatch_input', state: 'accepted' }] } })
    throw new Error('Unexpected mutation')
  }, 'orca', journal)
  run.tasks.build.recoveryAgent = 'codex'
  await client.repairPendingLaunches([run])
  assert.equal(run.tasks.build.recoveryAgent, undefined)
  assert.equal(run.tasks.build.attempts.length, 1)
  assert.equal(run.tasks.build.attempts[0].dispatchId, 'dispatch-restored')
  assert.equal(run.tasks.build.status, 'running')
  await client.repairPendingLaunches([run])
  assert.equal(run.tasks.build.attempts.length, 1)
})

test('ambiguous busy tasks and changed terminal identities retain the unconfirmed receipt', async () => {
  for (const changedTerminal of [false, true]) {
    const { run, entry } = fixture(), journal = new MemoryMutationJournal()
    await journal.put({ ...entry, ...(changedTerminal ? { result: { pipelineLaunchTerminal: { handle: 'term-owned', incarnationId: 'old' } } } : {}) })
    const client = new OrcaClient(async (_file, args) => {
      if (args[1] === 'worker-list') return result({ workers: [] })
      if (args[1] === 'task-list') return result({ tasks: [{ id: run.tasks.build.taskId, status: changedTerminal ? 'ready' : 'in_progress' }] })
      if (args[1] === 'show') return result({ terminal: { handle: 'term-owned', incarnationId: 'different' } })
      throw new Error('Unexpected mutation')
    }, 'orca', journal)
    await assert.rejects(() => client.repairPendingLaunches([run]))
    assert.equal((await journal.list())[0].status, 'pending')
    assert.equal(run.tasks.build.unconfirmedStart, true)
  }
})

test('repair of an attributed receipt leaves the other owner and its pending launch intact', async () => {
  const a = fixture('-a'), b = fixture('-b'), journal = new MemoryMutationJournal()
  const before = structuredClone(b.run)
  await journal.put(a.entry); await journal.put(b.entry)
  const client = new OrcaClient(async (_file, args) => {
    assert.ok(args.includes(a.run.runId))
    if (args[1] === 'worker-list') return result({ workers: [] })
    if (args[1] === 'task-list') return result({ tasks: [{ id: a.run.tasks.build.taskId, status: 'ready' }] })
    throw new Error('Unexpected command')
  }, 'orca', journal)
  const runs = [a.run, b.run]
  assert.deepEqual([...(await client.pendingScope(runs)).affected].sort(), runs.map(run => run.id).sort())
  await client.repairPendingLaunches(runs, a.run.id)
  assert.deepEqual(b.run, before)
  assert.deepEqual([...(await client.pendingScope(runs)).affected], [b.run.id])
  assert.equal((await journal.list()).find(row => row.requestId === b.entry.requestId)?.status, 'pending')
})

test('an unrelated launch-only receipt does not prevent repair of a saved run', async () => {
  const current = fixture(), deleted = fixture('-deleted'), journal = new MemoryMutationJournal()
  await journal.put(deleted.entry)
  await journal.put(current.entry)
  const client = new OrcaClient(async (_file, args) => {
    assert.ok(args.includes(current.run.runId))
    if (args[1] === 'worker-list') return result({ workers: [] })
    if (args[1] === 'task-list') return result({ tasks: [{ id: current.run.tasks.build.taskId, status: 'ready' }] })
    throw new Error('Unexpected command')
  }, 'orca', journal)
  const scope = await client.pendingScope([current.run])
  assert.equal(scope.ambiguous, undefined)
  assert.deepEqual([...scope.affected], [current.run.id])
  assert.deepEqual([...scope.orphanedLaunches], [deleted.entry.requestId])
  await client.repairPendingLaunches([current.run], current.run.id)
  assert.equal(current.run.tasks.build.unconfirmedStart, undefined)
  assert.deepEqual((await journal.list()).find(row => row.requestId === deleted.entry.requestId), deleted.entry)
})

test('a saved launch owner retains the retry identity after the startup record is gone', async () => {
  const { run, entry } = fixture(), journal = new MemoryMutationJournal()
  const launch = { runId: run.runId, taskId: run.tasks.build.taskId, retryOf: 'ctx_old_startup' }
  const hash = createHash('sha256').update(JSON.stringify([launch.runId, launch.taskId, launch.retryOf, 'codex'])).digest('hex').slice(0, 32)
  await journal.put({ ...entry, requestId: `pipeline-launch-${hash}`, launch })
  const client = new OrcaClient(async () => { throw new Error('Unexpected command') }, 'orca', journal)
  const scope = await client.pendingScope([run])
  assert.deepEqual([...scope.affected], [run.id])
  assert.equal(scope.orphanedLaunches.size, 0)
})
