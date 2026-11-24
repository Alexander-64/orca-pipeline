import { assert, test } from 'orca/testing'
import { ChunkedJsonStorage } from '../packages/core/chunked-storage'
import { StorageMutationJournal } from './mutations'

function boundedStorage() {
  const values = new Map<string, unknown>()
  let fail: ((key: string) => boolean) | undefined
  return {
    values,
    refuse: (predicate?: (key: string) => boolean) => { fail = predicate },
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: unknown) => {
      if (fail?.(key)) throw new Error('storage refused')
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144) throw new Error('value exceeds 262144 bytes')
      values.set(key, structuredClone(value))
    },
    delete: async (key: string) => { values.delete(key) }
  }
}

test('large snapshots round trip under the Orca byte limit and retain legacy inline reads', async () => {
  const host = boundedStorage(), store = new ChunkedJsonStorage(host)
  host.values.set('runs', [{ id: 'legacy' }])
  assert.deepEqual(await store.get('runs'), [{ id: 'legacy' }])
  const large = { text: ('Привет😀\u0000"\\').repeat(50000) }
  await store.set('runs', large)
  assert.deepEqual(await new ChunkedJsonStorage(host).get('runs'), large)
  await store.set('runs', { text: 'small again' })
  assert.deepEqual([...host.values.keys()], ['runs'])
  assert.deepEqual(await store.get('runs'), { text: 'small again' })
})

test('interrupted chunk or manifest writes preserve the last committed snapshot and allow retry', async () => {
  const host = boundedStorage(), store = new ChunkedJsonStorage(host)
  const previous = { text: 'old'.repeat(100000) }, next = { text: 'new'.repeat(100000) }
  await store.set('runs', previous)
  const keys = [...host.values.keys()].sort()
  for (const predicate of [(key: string) => key.endsWith('.1'), (key: string) => key === 'runs']) {
    host.refuse(predicate)
    await assert.rejects(() => store.set('runs', next), /storage refused/)
    assert.deepEqual(await new ChunkedJsonStorage(host).get('runs'), previous)
    assert.deepEqual([...host.values.keys()].sort(), keys)
  }
  host.refuse()
  await store.set('runs', next)
  assert.deepEqual(await store.get('runs'), next)
  const chunk = [...host.values.keys()].find(key => key !== 'runs')!
  host.values.delete(chunk)
  await assert.rejects(() => store.get('runs'), /Incomplete stored snapshot/)
})

test('journal growth beyond 256 KiB preserves receipts across concurrent writes and restart', async () => {
  const host = boundedStorage()
  const legacy = { requestId: 'legacy', args: ['x'.repeat(260000)], status: 'completed' as const }
  host.values.set('pipeline.mutations.v1', [legacy])
  const journal = new StorageMutationJournal(host)
  await Promise.all(Array.from({ length: 4 }, (_, index) => journal.put({ requestId: `new-${index}`, args: ['я'.repeat(10000)], status: 'pending' })))
  const restored = new StorageMutationJournal(host)
  const records = await restored.list()
  assert.equal(records.length, 5)
  assert.deepEqual(records[0], legacy)
  await restored.put({ ...records[1], status: 'completed', result: { id: 'task-created' } })
  assert.equal((await new StorageMutationJournal(host).list())[1].status, 'completed')
})
