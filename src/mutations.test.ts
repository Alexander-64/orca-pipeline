import { assert, test } from 'orca/testing'
import { OrcaClient, type CommandResult } from './cli'
import { MemoryMutationJournal, StorageMutationJournal } from './mutations'

const success = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })

test('records a successful mutation and its request ID', async () => {
  const journal = new MemoryMutationJournal()
  let args: string[] = []
  const client = new OrcaClient(async (_file, argv) => {
    args = argv
    return success({ run: { id: 'run_1' } })
  }, 'orca', journal)
  assert.equal(await client.createRun('objective', 'term_1'), 'run_1')
  const index = args.indexOf('--retry-request')
  assert.ok(index > 0)
  const records = await journal.list()
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'completed')
  assert.equal(args[index + 1], records[0].requestId)
})

test('uses a completed receipt after a transport failure without replaying the mutation', async () => {
  const journal = new MemoryMutationJournal()
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    if (calls.length === 1) throw new Error('socket lost')
    return success({ status: 'completed', receipt: { run: { id: 'run_recovered' } } })
  }, 'orca', journal)
  assert.equal(await client.createRun('objective', 'term_1'), 'run_recovered')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('request-show'))
  assert.equal((await journal.list())[0].status, 'completed')
})

test('replays a pending mutation with the exact same request ID', async () => {
  const journal = new MemoryMutationJournal()
  const mutationIds: string[] = []
  let mutationCalls = 0
  const client = new OrcaClient(async (_file, args) => {
    if (args.includes('request-show')) return success({ status: 'pending' })
    mutationCalls += 1
    mutationIds.push(args[args.indexOf('--retry-request') + 1])
    if (mutationCalls === 1) throw new Error('timeout')
    return success({ run: { id: 'run_replayed' } })
  }, 'orca', journal)
  assert.equal(await client.createRun('objective', 'term_1'), 'run_replayed')
  assert.equal(mutationCalls, 2)
  assert.equal(mutationIds[0], mutationIds[1])
})

test('does not blindly replay an absent mutation', async () => {
  const journal = new MemoryMutationJournal()
  let mutationCalls = 0
  const client = new OrcaClient(async (_file, args) => {
    if (args.includes('request-show')) return success({ state: 'absent' })
    mutationCalls += 1
    throw new Error('connection lost')
  }, 'orca', journal)
  await assert.rejects(() => client.createRun('objective', 'term_1'), /absent/)
  assert.equal(mutationCalls, 1)
  assert.equal((await journal.list())[0].status, 'failed')
})

test('does not recover a structured business error', async () => {
  const journal = new MemoryMutationJournal()
  let calls = 0
  const client = new OrcaClient(async () => {
    calls += 1
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'task_not_startable' } }), stderr: '' }
  }, 'orca', journal)
  await assert.rejects(() => client.createRun('objective', 'term_1'), /task_not_startable/)
  assert.equal(calls, 1)
  assert.equal((await journal.list())[0].status, 'failed')
})

test('recovers a pending record from a previous client without duplicating it', async () => {
  const journal = new MemoryMutationJournal()
  await journal.put({
    requestId: 'request-persisted',
    args: ['orchestration', 'run-create', '--objective', 'test', '--from', 'term_1'],
    status: 'pending'
  })
  let mutationCalls = 0
  const client = new OrcaClient(async (_file, args) => {
    if (!args.includes('request-show')) mutationCalls += 1
    return success({ status: 'completed', receipt: { run: { id: 'run_old' } } })
  }, 'orca', journal)
  await client.recoverPending()
  assert.equal(mutationCalls, 0)
  assert.equal((await journal.list())[0].status, 'completed')
})

test('persists the journal through plugin storage', async () => {
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => { values.set(key, value) }
  }
  const journal = new StorageMutationJournal(storage)
  await journal.put({ requestId: 'r1', args: ['test'], status: 'pending' })
  const restored = new StorageMutationJournal(storage)
  assert.deepEqual((await restored.list())[0], { requestId: 'r1', args: ['test'], status: 'pending' })
})
