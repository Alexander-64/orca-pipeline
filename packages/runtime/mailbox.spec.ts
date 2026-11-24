import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerMailbox, enqueueMessage, interactions } from './mailbox'

async function fixture(run: (mailbox: WorkerMailbox, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pipeline-mailbox-'))
  const mailbox = new WorkerMailbox(directory, 'test-token', () => {})
  await mailbox.start()
  try { await run(mailbox, directory) } finally { await mailbox.close(); await rm(directory, { recursive: true, force: true }) }
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Expected receipt did not arrive')
}

test('SDK acceptance is queued; observed context delivery is durable and never replayed', async () => fixture(async (mailbox, directory) => {
  const calls: string[] = []
  mailbox.setControls({ isActive: () => true, steer: async text => { calls.push(text) } })
  await enqueueMessage(directory, 'test-token', { id: 'm1', text: 'keep $VALUE; "quotes"' })
  await mailbox.poll()
  assert.equal((await interactions(directory)).messages[0].state, 'queued')
  mailbox.delivered('m1')
  await until(async () => (await interactions(directory)).messages[0].state === 'delivered')
  await mailbox.poll(); await mailbox.close()
  const replacement = new WorkerMailbox(directory, 'test-token', () => {})
  await replacement.start(); replacement.setControls({ isActive: () => true, steer: async text => { calls.push(text) } })
  try { await replacement.poll() } finally { await replacement.close() }
  assert.deepEqual(calls, ['[Pipeline user message m1]\nkeep $VALUE; "quotes"'])
  assert.equal((await interactions(directory)).messages[0].state, 'delivered')
}))

test('ambiguous SDK error persists unknown before invocation and cannot cause duplicate delivery', async () => fixture(async (mailbox, directory) => {
  let calls = 0
  mailbox.setControls({ isActive: () => true, steer: async () => {
    calls++
    assert.equal((await interactions(directory)).messages[0].state, 'unknown')
    throw new Error('Connection closed after accept')
  } })
  await enqueueMessage(directory, 'test-token', { id: 'm2', text: 'hello' })
  await mailbox.poll(); await mailbox.poll()
  assert.equal((await interactions(directory)).messages[0].state, 'unknown')
  assert.equal(calls, 1)
}))

test('question waits for its matching answer; answering is independent of ordinary steering', async () => fixture(async (mailbox, directory) => {
  const abort = new AbortController()
  const answer = mailbox.ask('Какая цель?', abort.signal, 'tool-1')
  await until(async () => (await interactions(directory)).questions.length === 1)
  const question = (await interactions(directory)).questions[0]
  assert.equal(question.state, 'waiting')
  await enqueueMessage(directory, 'test-token', { id: 'answer', text: 'Улучшить UX', questionId: question.id })
  await mailbox.poll()
  assert.equal(await answer, 'Улучшить UX')
  const state = await interactions(directory)
  assert.equal(state.questions[0].state, 'answered')
  assert.equal(state.questions[0].answerMessageId, 'answer')
  assert.equal(state.messages[0].state, 'queued')
  mailbox.deliveredQuestion('tool-1')
  await until(async () => (await interactions(directory)).messages[0].state === 'delivered')
  await enqueueMessage(directory, 'test-token', { id: 'late-answer', text: 'duplicate', questionId: question.id })
  await mailbox.poll()
  assert.equal((await interactions(directory)).messages.find(message => message.id === 'late-answer')?.state, 'rejected')
}))

test('abort cancels a pending question and close rejects messages that never entered context', async () => fixture(async (mailbox, directory) => {
  const abort = new AbortController()
  const answer = mailbox.ask('Wait?', abort.signal)
  const rejected = assert.rejects(answer, /Question cancelled/)
  await until(async () => (await interactions(directory)).questions.length === 1)
  abort.abort(); await rejected
  mailbox.setControls({ isActive: () => true, steer: async () => {} })
  await enqueueMessage(directory, 'test-token', { id: 'undelivered', text: 'hello' })
  await mailbox.poll(); await mailbox.close()
  assert.equal((await interactions(directory)).questions[0].state, 'cancelled')
  assert.equal((await interactions(directory)).messages[0].state, 'rejected')
  await enqueueMessage(directory, 'test-token', { id: 'late', text: 'hello' })
  await mailbox.poll()
  assert.equal((await interactions(directory)).messages.find(message => message.id === 'late')?.state, 'rejected')
}))

test('wrong tokens, conflicting identities and invalid input cannot deliver', async () => fixture(async (mailbox, directory) => {
  let calls = 0
  mailbox.setControls({ isActive: () => true, steer: async () => { calls++ } })
  await enqueueMessage(directory, 'wrong-token', { id: 'wrong', text: 'hello' }); await mailbox.poll()
  assert.equal(calls, 0)
  assert.equal((await interactions(directory)).messages.length, 0)
  await assert.rejects(enqueueMessage(directory, 'test-token', { id: '../escape', text: 'hello' }), /identity/)
  await assert.rejects(enqueueMessage(directory, 'test-token', { id: 'empty', text: ' ' }), /characters/)
  await enqueueMessage(directory, 'test-token', { id: 'same', text: 'hello' })
  await assert.rejects(enqueueMessage(directory, 'test-token', { id: 'same', text: 'different' }), /different/)
  await mailbox.poll()
  assert.equal(calls, 1)
}))
