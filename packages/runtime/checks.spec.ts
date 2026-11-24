import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RunStore } from './store'
import { ChecksSupervisor, type ChecksRecord } from './checks'
import { atomicJson } from './files'
import { checkCommand } from './acceptance'

const actor = fileURLToPath(new URL('./checks-actor.ts', import.meta.url))
const command = (code: string) => process.execPath + ' -e ' + JSON.stringify(code)
const absent = (pid: number, group = false) => { try { process.kill(group ? -pid : pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }
async function until(check: () => Promise<boolean> | boolean) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, 'Condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)) } }
async function setup(t: { after(fn: () => Promise<void>): void }, loseLaunchReceipt = false) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-check-actor-'))
  class Store extends RunStore {
    override put(key: string, value: unknown, ...rest: [string?, unknown?]) {
      if (loseLaunchReceipt && key.startsWith('native-checks:') && (value as ChecksRecord)?.stage === 'launched') { loseLaunchReceipt = false; throw new Error('Injected launch receipt gap') }
      super.put(key, value, ...rest)
    }
  }
  const store = new Store(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const service = new ChecksSupervisor(store, project)
  t.after(async () => { for (const record of service.records()) await service.cancel(record); store.close(); await rm(project, { recursive: true, force: true }) })
  const input = (commands: string[]) => ({ runId: 'native-run', taskId: 'native-task', dispatchId: 'dispatch', result: { provenance: 'worker_report', outcome: 'succeeded', body: 'Actual report' }, commands, policy: { readOnly: false } })
  return { project, store, service, input }
}

test('detached acceptance stores command receipts and survives a new supervisor instance without repetition', async t => {
  const h = await setup(t)
  const input = h.input([command("require('node:fs').appendFileSync('count.txt','x')"), 'pwd'])
  assert.notEqual((await h.service.ensure(input)).state, 'unknown')
  const restored = new ChecksSupervisor(h.store, h.project)
  await until(async () => (await restored.ensure(input)).state === 'finished')
  const observation = await restored.ensure(input)
  assert.equal(observation.result?.outcome, 'succeeded')
  assert.ok(observation.checks.every(check => check.exitCode === 0))
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
  assert.equal(h.store.events().filter(event => event.kind === 'acceptance.launched').length, 1)
  const record = restored.records()[0]
  const receipt = JSON.parse(await readFile(join(record.directory, 'command-0.result.json'), 'utf8'))
  assert.equal(receipt.id, record.id); assert.equal(receipt.check.command, input.commands[0])
  await unlink(join(record.directory, 'result.json'))
  assert.equal((await restored.ensure(input)).result?.outcome, 'succeeded', 'Durable SQL receipt also prevents repetition after log cleanup')
  await assert.rejects(restored.ensure({ ...input, result: { ...input.result, body: 'Changed after completion' } }), /report changed/)
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
})

test('a crash after process spawn but before the launch receipt adopts the actor result without another launch', async t => {
  const h = await setup(t, true)
  const input = h.input([command("require('node:fs').appendFileSync('count.txt','x')")])
  await assert.rejects(h.service.ensure(input), /launch receipt gap/)
  assert.equal(h.service.records()[0].stage, 'intent')
  const restored = new ChecksSupervisor(h.store, h.project)
  await until(async () => (await restored.ensure(input)).state === 'finished')
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
  assert.equal(h.service.records().length, 1)
  assert.equal(h.store.events().filter(event => event.kind === 'acceptance.intent').length, 1)
})

test('a mismatched or incomplete final receipt cannot fabricate successful acceptance', async t => {
  const h = await setup(t), id = 'receipt-validation'
  const directory = join(h.project, '.agent-pipeline/runtime/native-checks', id)
  const record: ChecksRecord = { id, runId: 'run', taskId: 'task', dispatchId: 'dispatch', directory, nativeResult: {}, stage: 'intent', request: { version: 1, id, runId: 'run', taskId: 'task', token: 'fixture', cwd: h.project, commands: ['pwd'] } }
  h.store.put('native-checks:' + id, record)
  const base = { version: 1, id, runId: 'run', taskId: 'task', outcome: 'succeeded', checks: [], finishedAt: new Date().toISOString() }
  for (const receipt of [base, { ...base, checks: [{ command: 'echo fake', exitCode: 0, output: 'fake' }] }, { ...base, outcome: 'failed', checks: [{ command: 'pwd', exitCode: 0, output: h.project }], failure: { version: 1, phase: 'acceptance', kind: 'unknown', message: 'fake failure' } }]) {
    await atomicJson(join(directory, 'result.json'), receipt)
    await assert.rejects(h.service.observe(record), /does not prove/)
    assert.equal(h.service.records()[0].result, undefined)
  }
  await unlink(join(directory, 'result.json')); await h.service.cancel(record)
})

test('cancellation reaches an active acceptance process group and preserves earlier checks', async t => {
  const h = await setup(t)
  await h.service.ensure(h.input(['pwd', command("require('node:fs').writeFileSync('running','yes'),setTimeout(function(){},30000)")]))
  await until(async () => readFile(join(h.project, 'running')).then(() => true, () => false))
  const record = h.service.records()[0]
  // The child can write its marker before the supervisor publishes its PID receipt.
  await until(async () => readFile(join(record.directory, 'command-1.child.json')).then(() => true, () => false))
  const child = JSON.parse(await readFile(join(record.directory, 'command-1.child.json'), 'utf8'))
  await h.service.requestStop(record.runId)
  const result = await h.service.cancel(record)
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.failure?.phase, 'cancellation')
  assert.equal(result.checks[0].exitCode, 0); assert.equal(result.checks[1].exitCode, null)
  await until(() => absent(child.pid, true))
})

test('a cancellation fence prevents a late actor from executing after an ambiguous launch', async t => {
  const h = await setup(t), id = 'fenced-check'
  const directory = join(h.project, '.agent-pipeline/runtime/native-checks', id)
  const request = { version: 1 as const, id, runId: 'run', taskId: 'task', token: 'private-fixture-token', cwd: h.project, commands: [command("require('node:fs').writeFileSync('must-not-exist','bad')")] }
  const record: ChecksRecord = { id, runId: 'run', taskId: 'task', dispatchId: 'dispatch', directory, request, nativeResult: {}, stage: 'intent' }
  h.store.put('native-checks:' + id, record)
  await mkdir(directory, { recursive: true }); await atomicJson(join(directory, 'request.json'), request)
  assert.equal((await h.service.observe(record)).state, 'unknown')
  assert.equal((await h.service.cancel(record)).outcome, 'cancelled')
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), actor, join(directory, 'request.json')], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  await assert.rejects(readFile(join(h.project, 'must-not-exist')), { code: 'ENOENT' })
  assert.equal((await h.service.observe(record)).result?.outcome, 'cancelled')
})

test('a killed actor cannot replay an interrupted command or claim cancellation while its child group is alive', async t => {
  const h = await setup(t)
  const input = h.input([command("require('node:fs').appendFileSync('count.txt','x'),setTimeout(function(){},30000)")])
  await h.service.ensure(input)
  await until(async () => readFile(join(h.project, 'count.txt')).then(() => true, () => false))
  const record = h.service.records()[0]
  const started = JSON.parse(await readFile(join(record.directory, 'started.json'), 'utf8'))
  const child = JSON.parse(await readFile(join(record.directory, 'command-0.child.json'), 'utf8'))
  assert.equal(child.actorPid, started.pid)
  t.after(async () => { if (!absent(child.pid, true)) process.kill(-child.pid, 'SIGKILL') })
  process.kill(started.pid, 'SIGKILL') // Only this test's acceptance actor.
  await until(() => absent(started.pid))
  const restored = new ChecksSupervisor(h.store, h.project)
  assert.equal((await restored.ensure(input)).state, 'unknown')
  await assert.rejects(restored.reconcile(record.runId), /unknown command outcome/)
  await assert.rejects(restored.cancel(record), /cancellation unconfirmed/)
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
  assert.equal(h.store.events().filter(event => event.kind === 'acceptance.launched').length, 1)
  process.kill(-child.pid, 'SIGKILL') // Verified live process group created by this test's recorded command.
  await until(() => absent(child.pid, true))
  const cancelled = await restored.cancel(record)
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.checks[0].exitCode, null)
  assert.match(cancelled.checks[0].error!, /result is unknown/)
})

test('completed durable command receipts reconstruct a missing final result without rerunning the command', async t => {
  const h = await setup(t), id = 'reconstruct'
  const directory = join(h.project, '.agent-pipeline/runtime/native-checks', id)
  const once = command("require('node:fs').appendFileSync('count.txt','x')")
  const check = await checkCommand(once, h.project)
  assert.equal(check.exitCode, 0)
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
  await until(() => absent(dead))
  const record: ChecksRecord = { id, runId: 'run', taskId: 'task', dispatchId: 'dispatch', directory, pid: dead, stage: 'launched', nativeResult: {}, request: { version: 1, id, runId: 'run', taskId: 'task', token: 'fixture', cwd: h.project, commands: [once] } }
  h.store.put('native-checks:' + id, record)
  await atomicJson(join(directory, 'command-0.result.json'), { id, index: 0, check, finishedAt: new Date().toISOString() })
  assert.equal((await h.service.observe(record)).result?.outcome, 'succeeded')
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
})
