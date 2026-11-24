import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StorageMutationJournal } from './mutations'

test('concurrent lifecycle receipts cannot overwrite another operation in asynchronous host storage', async () => {
  let value: unknown = [], refuse = false
  const journal = new StorageMutationJournal({
    get: async () => { const snapshot = structuredClone(value); await new Promise(resolve => setTimeout(resolve, 2)); return snapshot },
    set: async (_key, next) => { if (refuse) { refuse = false; throw new Error('Transient storage refusal') }; await new Promise(resolve => setTimeout(resolve, 2)); value = structuredClone(next) }
  })
  await Promise.all(Array.from({ length: 8 }, (_, index) => journal.put({ requestId: 'operation-' + index, args: ['fixture', String(index)], status: 'pending' })))
  assert.equal((await journal.list()).length, 8)
  await Promise.all(Array.from({ length: 8 }, (_, index) => journal.put({ requestId: 'operation-' + index, args: ['fixture', String(index)], status: 'completed', result: { id: index } })))
  assert.ok((await journal.list()).every(row => row.status === 'completed'))
  refuse = true
  await assert.rejects(journal.put({ requestId: 'refused', args: [], status: 'pending' }), /storage refusal/)
  await journal.put({ requestId: 'after-refusal', args: [], status: 'pending' })
  assert.equal((await journal.list()).length, 9)
})
