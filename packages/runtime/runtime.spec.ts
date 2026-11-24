import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RunStore } from './store'
import { LocalBackend } from './backend'
import { commandArgs, checkCommand } from './acceptance'
import { runCommandExecutor } from './executor'
import { Coordinator } from '../core/coordinator'
import { parseScenario } from '../core/scenario'
import type { PipelineRun } from '../core/types'
import { confinedPath } from '../pi-adapter/session'

const fixture = fileURLToPath(new URL('./fixtures/executor.mjs', import.meta.url))
const executor = (delay = 10, mode?: string) => ({ kind: 'jsonl' as const, executable: process.execPath, args: [fixture, String(delay), ...(mode ? [mode] : [])] })
const scenario = (steps = `- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  acceptance: [pwd]`) => parseScenario(`name: terminal-test\nobjective: Test\ncommandPolicy: {readOnly: true}\nsteps:\n${steps.split('\n').map(line => '  ' + line).join('\n')}\n`)

async function harness(t: { after(fn: () => Promise<void> | void): void }, delay = 10, mode?: string) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-runtime-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const backend = new LocalBackend(store, project, { executors: { fixture: executor(delay, mode), backup: executor() } })
  const coordinator = new Coordinator({ client: backend, save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  t.after(async () => {
    for (const run of coordinator.list()) if (!['done', 'cancelled'].includes(run.status)) await coordinator.cancel(run.id).catch(() => {})
    store.close(); await rm(project, { recursive: true, force: true })
  })
  const start = (source = scenario()) => coordinator.start({ id: 'folder:' + project, kind: 'folder', name: 'test', path: project, branch: null, hostId: null }, 'test-owner', source)
  return { project, store, backend, coordinator, start }
}

async function until(check: () => Promise<boolean> | boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error('Condition timed out')
}

test('SQLite persists snapshots and ordered events across reconnect; readonly readers cannot mutate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-store-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.sqlite')
  const first = new RunStore(path); first.put('run:1', { status: 'paused' }, 'run.changed', { token: 'Bearer example-private-value' }); first.close()
  const second = new RunStore(path, true)
  assert.deepEqual(second.get('run:1'), { status: 'paused' })
  assert.equal(second.events()[0].seq, 1)
  assert.doesNotMatch(JSON.stringify(second.events()), /example-private-value/)
  assert.throws(() => second.put('x', {})); second.close()
})

test('acceptance is argv, rejects shell expansion, preserves quotes and captures real exit codes', async () => {
  assert.deepEqual(commandArgs(`node -e "process.exit(7)" 'two words'`), ['node', '-e', 'process.exit(7)', 'two words'])
  for (const command of ['ls; echo x', 'echo $(pwd)', 'ls | cat', 'echo > file', 'echo `pwd`', 'echo "unclosed']) assert.throws(() => commandArgs(command))
  const result = await checkCommand(`${process.execPath} -e 'process.exit(7)'`, process.cwd())
  assert.equal(result.exitCode, 7)
})

test('executor exit zero without a valid completion is failure', async () => {
  await assert.rejects(runCommandExecutor(executor(0, 'bad-json'), process.cwd(), 'Task', true, new AbortController().signal, () => {}), /not JSONL/)
})

test('file tools reject escapes and symlinks outside the project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-path-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project')); await writeFile(join(root, 'outside'), 'private')
  await symlink(join(root, 'outside'), join(root, 'project', 'link'))
  await assert.rejects(confinedPath(join(root, 'project'), '../outside'), /outside/)
  await assert.rejects(confinedPath(join(root, 'project'), 'link'), /outside/)
  await assert.rejects(confinedPath(join(root, 'project'), '.env'), /Protected/)
  await assert.rejects(confinedPath(join(root, 'project'), '.agent-pipeline/runtime/result.json', true), /Protected/)
})

test('three sequential steps create distinct workers, store reports and acceptance evidence', async t => {
  const h = await harness(t)
  const run = await h.start(scenario(`- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  acceptance: [pwd]\n- id: improve\n  title: Improve\n  spec: Prioritize\n  agent: fixture\n  needs: [audit]\n  acceptance: [pwd]\n- id: review\n  title: Review\n  spec: Review\n  agent: fixture\n  needs: [improve]\n  acceptance: [pwd]`))
  await until(async () => { await h.coordinator.tick(run.id); return h.coordinator.get(run.id).status === 'done' })
  const tasks = Object.values(run.tasks)
  assert.equal(new Set(tasks.map(task => task.attempts[0].dispatchId)).size, 3)
  for (const task of tasks) { assert.equal(task.attempts[0].checks?.[0].exitCode, 0); assert.match(task.attempts[0].output!, /Fixture report/) }
  const stored = h.store.list<{ result?: { text: string } }>('attempt:')
  assert.equal(stored.length, 3); assert.ok(stored.every(attempt => attempt.result?.text))
})

test('approval blocks the dependent worker until explicit user resolution', async t => {
  const h = await harness(t)
  const run = await h.start(scenario('- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  approval: Approve audit\n  acceptance: [pwd]'))
  assert.equal(run.tasks.audit.status, 'blocked'); assert.equal(h.store.list('attempt:').length, 0)
  await h.coordinator.resolveGate(run.id, 'audit', 'approve')
  await until(async () => { await h.coordinator.tick(run.id); return run.status === 'done' })
  assert.equal(h.store.list('attempt:').length, 1)
})

test('confirmed quota failure switches only to configured fallback and preserves checkpoint', async t => {
  const h = await harness(t, 10, 'quota')
  const run = await h.start(scenario('- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  fallback: [backup]\n  acceptance: [pwd]'))
  await until(async () => { await h.coordinator.tick(run.id); return run.status === 'done' })
  assert.deepEqual(run.tasks.audit.attempts.map(attempt => attempt.agent), ['fixture', 'backup'])
  const attempt = h.store.list<{ agent: string; directory: string }>('attempt:').find(attempt => attempt.agent === 'backup')!
  assert.match(await readFile(join(attempt.directory, 'request.json'), 'utf8'), /Previous attempt checkpoint/)
})

test('failed acceptance prevents success even after a valid executor completion', async t => {
  const h = await harness(t)
  const config = scenario(); config.commandPolicy = undefined; config.steps[0].acceptance = [`${process.execPath} -e 'process.exit(4)'`]
  const run = await h.start(config)
  await until(async () => { await h.coordinator.tick(run.id); return run.status === 'failed' })
  assert.equal(h.store.list<{ result?: { checks: { exitCode: number }[] } }>('attempt:')[0].result?.checks[0].exitCode, 4)
  assert.equal(run.tasks.audit.attempts[0].checks?.[0].exitCode, 4)
})

test('restoring a coordinator observes orphan receipts without starting duplicate workers', async t => {
  const h = await harness(t, 100)
  const run = await h.start()
  const snapshot = structuredClone(run)
  // Simulate a crash after the backend spawned a worker but before the run snapshot recorded it.
  snapshot.tasks.audit.attempts = []; snapshot.tasks.audit.status = 'pending'
  await h.backend.reconcile(snapshot)
  const restored = new Coordinator({ client: h.backend, save: async run => h.store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  restored.restore([snapshot])
  await until(async () => { await restored.tick(run.id); return restored.get(run.id).status === 'done' })
  assert.equal(h.store.list('attempt:').length, 1)
  assert.equal(restored.get(run.id).tasks.audit.attempts.length, 1)
})

test('concurrent pause and polls do not dispatch dependent steps', async t => {
  const h = await harness(t, 200)
  const run = await h.start(scenario('- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  acceptance: [pwd]\n- id: review\n  title: Review\n  spec: Review\n  agent: fixture\n  needs: [audit]\n  acceptance: [pwd]'))
  await Promise.all([h.coordinator.pause(run.id), h.coordinator.tick(run.id), h.coordinator.tick(run.id)])
  await until(async () => { await h.coordinator.tick(run.id); return run.tasks.audit.status === 'done' })
  assert.equal(h.store.list('attempt:').length, 1); assert.equal(run.status, 'paused')
  await h.coordinator.resume(run.id)
  await until(async () => { await h.coordinator.tick(run.id); return run.status === 'done' })
})

test('unknown startup intent cannot be replayed or substituted', async t => {
  const h = await harness(t)
  const config = scenario(); config.steps[0].approval = 'wait'
  const run = await h.start(config)
  const step = run.scenario.steps[0]
  const { createHash } = await import('node:crypto')
  const id = createHash('sha256').update(`${run.tasks.audit.taskId}:initial:fixture`).digest('hex').slice(0, 32)
  h.store.put('attempt:' + id, { id, stage: 'intent' })
  await assert.rejects(h.backend.startWorker(run, step, run.tasks.audit.taskId, 'fixture'), /Unknown startup/)
  assert.equal(h.store.list('attempt:').length, 1)
})

test('unsupported executor or placement fails before creating a run', async t => {
  const h = await harness(t)
  const config = scenario(); config.steps[0].agent = 'not-installed'
  await assert.rejects(h.start(config), /not configured/)
  assert.equal(h.store.list('native-run:').length, 0)
})

test('legacy branch fields require explicit v2 and unknown scenario versions remain rejected', () => {
  const source = 'name: branch\nobjective: Branch\nsteps:\n  - id: audit\n    title: Audit\n    spec: Read\n    agent: pi\n    acceptance: [pwd]\n    when: {step: previous, field: verdict, equals: ok}\n'
  assert.throws(() => parseScenario(source), /version: 2/)
  assert.equal(parseScenario('version: 2\n' + source.replace(/    when:.*\n/, '')).version, 2)
  assert.throws(() => parseScenario('version: 3\n' + source.replace(/    when:.*\n/, '')), /версии/)
})

test('provider limits apply across executor aliases and writing a checkout is serialized', async t => {
  const h = await harness(t, 100)
  h.backend.config.executors.fixture.provider = 'shared'
  h.backend.config.executors.backup.provider = 'shared'
  const config = scenario('- id: audit\n  title: Audit\n  spec: Analyze\n  agent: fixture\n  acceptance: [pwd]\n- id: review\n  title: Review\n  spec: Independently analyze\n  agent: backup\n  acceptance: [pwd]')
  config.providerLimits = { shared: 1 }
  // A fresh backend snapshots the configured aliases.
  const backend = new LocalBackend(h.store, h.project, h.backend.config)
  const coordinator = new Coordinator({ client: backend, save: async run => h.store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  const run = await coordinator.start({ id: 'folder:' + h.project, kind: 'folder', name: 'test', path: h.project, branch: null, hostId: null }, 'owner', config)
  assert.equal(h.store.list('attempt:').length, 1)
  await until(async () => { await coordinator.tick(run.id); return run.status === 'done' })
  assert.equal(h.store.list('attempt:').length, 2)
  const writing = structuredClone(config); writing.commandPolicy = undefined; writing.providerLimits = undefined
  const writeRun = await coordinator.start({ id: 'folder:' + h.project, kind: 'folder', name: 'test', path: h.project, branch: null, hostId: null }, 'owner', writing)
  assert.equal(h.store.list('attempt:').length, 3)
  await until(async () => { await coordinator.tick(writeRun.id); return writeRun.status === 'done' })
  assert.equal(h.store.list('attempt:').length, 4)
})
