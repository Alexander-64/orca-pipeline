import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConsoleController } from './agent'
import type { Request } from '../core/terminal-ipc'
import type { PipelineRun } from '../core/types'

const source = 'name: console-draft\nobjective: Test\ncommandPolicy: {readOnly: true}\nsteps:\n - {id: audit, title: Audit, agent: fixture, spec: Read, acceptance: [pwd]}\n'
const config = { executors: { fixture: { kind: 'jsonl' as const, executable: process.execPath } } }
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-console-host-')); t.after(() => rm(project, { recursive: true, force: true }))
  const calls: Request[] = [], receipts = new Map<string, PipelineRun>()
  let loseReceipt = false
  const call = async (message: Request): Promise<unknown> => {
    calls.push(message)
    if (message.command === 'status') return { runs: [...receipts.values()] }
    let result = receipts.get(message.id)
    if (!result) { result = { id: 'run-' + receipts.size, status: 'running' } as PipelineRun; receipts.set(message.id, result) }
    if (loseReceipt) { loseReceipt = false; throw new Error('Connection lost after the runtime accepted the request') }
    return result
  }
  return { project, calls, receipts, call, lose: () => { loseReceipt = true } }
}

test('console plan and update validate drafts, preserve the original and do not launch workers', async t => {
  const h = await setup(t), controller = new ConsoleController(h.project, config, h.call)
  const planned = await controller.plan(source), before = await readFile(planned.file, 'utf8')
  const updated = await controller.update(source.replace('console-draft', 'updated-draft'))
  assert.notEqual(planned.file, updated.file)
  assert.equal(await readFile(planned.file, 'utf8'), before)
  assert.match(await readFile(updated.file, 'utf8'), /updated-draft/)
  assert.equal(h.calls.length, 0); assert.equal(h.receipts.size, 0)
  await assert.rejects(controller.update(source.replace('agent: fixture', 'agent: unavailable')), /not configured/)
  await writeFile(updated.file, 'External edit')
  await assert.rejects(controller.update(source), /changed on disk/)
  await assert.rejects(controller.control('run', 'start'), /changed on disk/)
  assert.equal(h.receipts.size, 0)
})

test('console control replays a lost receipt using the same durable operation identity', async t => {
  const h = await setup(t)
  const first = new ConsoleController(h.project, config, h.call)
  const draft = await first.plan(source)
  h.lose()
  await assert.rejects(first.control('run', 'lost-call'), /Connection lost/)
  const second = new ConsoleController(h.project, config, h.call, { draft: { file: draft.file, source: await readFile(draft.file, 'utf8') } })
  const result = await second.control('run', 'new-tool-call')
  assert.equal(h.receipts.size, 1)
  const mutations = h.calls.filter(call => call.command === 'run')
  assert.equal(mutations.length, 2); assert.equal(mutations[0].id, mutations[1].id)
  assert.equal(result.id, 'run-0')
  const receipt = JSON.parse(await readFile(join(h.project, '.agent-pipeline/console', mutations[0].id + '.receipt.json'), 'utf8'))
  assert.equal(receipt.result.id, result.id)
  await assert.rejects(second.control('run', 'duplicate'), /already started a run/)
})

test('console cannot approve gates, control an implicit run, or bypass an unresolved different operation', async t => {
  const h = await setup(t), controller = new ConsoleController(h.project, config, h.call)
  await assert.rejects(controller.control('approve' as 'run', 'gate'), /explicit operator/)
  await assert.rejects(controller.control('stop', 'unselected'), /Select a run explicitly/)
  await controller.plan(source); h.lose()
  await assert.rejects(controller.control('run', 'unknown'), /Connection lost/)
  const other = new ConsoleController(h.project, config, h.call, { runId: 'run-0' })
  await assert.rejects(other.control('stop', 'different'), /unknown outcome/)
  assert.equal(h.calls.filter(call => call.command === 'stop').length, 0)
})
