import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { currentBootId, processExited } from './process-lifetime'
import { ChecksSupervisor, type ChecksRecord } from './checks'
import { RunStore } from './store'
import { atomicJson } from './files'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))
test('a previous boot proves old processes exited without signalling a reused current PID', () => {
  assert.ok(currentBootId(), 'macOS/Linux must provide a stable kernel boot identity')
  assert.equal(processExited(process.pid, currentBootId()), false)
  assert.equal(processExited(process.pid, 'previous-boot-fixture'), true)
  assert.equal(processExited(undefined), false)
  assert.equal(processExited(undefined, 'previous-boot-fixture'), true)
  process.kill(process.pid, 0) // No signal was sent to the current process.
})

test('a supervisor lock from a previous boot cannot be confused with a live reused PID', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-boot-lock-'))
  const directory = join(project, '.agent-pipeline/runtime'); await mkdir(directory, { recursive: true })
  await atomicJson(join(directory, 'supervisor.lock'), { pid: process.pid, token: 'old-owner', bootId: 'previous-boot-fixture' })
  const command = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '-C', project, '--json'], { timeout: 15000 })).stdout)
  t.after(async () => { try { await command('shutdown'); await new Promise(resolve => setTimeout(resolve, 100)) } finally { await rm(project, { recursive: true, force: true }) } })
  await command('status')
  const owner = JSON.parse(await readFile(join(directory, 'supervisor.lock'), 'utf8'))
  assert.notEqual(owner.token, 'old-owner'); assert.equal(owner.bootId, currentBootId())
  assert.notEqual(owner.pid, process.pid); process.kill(process.pid, 0)
})

test('simultaneous clients recovering a stale owner elect one writer transactionally', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-owner-election-'))
  const directory = join(project, '.agent-pipeline/runtime'); await mkdir(directory, { recursive: true })
  await atomicJson(join(directory, 'supervisor.lock'), { pid: process.pid, token: 'stale-owner', bootId: 'previous-boot-fixture' })
  const command = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '-C', project, '--json'], { timeout: 20000 })).stdout)
  t.after(async () => { try { await command('shutdown'); await new Promise(resolve => setTimeout(resolve, 150)) } finally { await rm(project, { recursive: true, force: true }) } })
  await Promise.all(Array.from({ length: 5 }, () => command('status')))
  const fileOwner = JSON.parse(await readFile(join(directory, 'supervisor.lock'), 'utf8'))
  const store = new RunStore(join(directory, 'state.sqlite'), true)
  try {
    const databaseOwner = store.get<{ pid: number; token: string }>('runtime:supervisor-owner')!
    assert.equal(databaseOwner.pid, fileOwner.pid); assert.equal(databaseOwner.token, fileOwner.token)
    assert.equal(store.events().filter(event => event.kind === 'supervisor.ready').length, 1)
  } finally { store.close() }
  // Losing contenders can still be loading modules when the winning socket answers.
  // They must exit without ever acquiring the lease or starting another scheduler.
  let processes: string[] = []
  const deadline = Date.now() + 10000
  do {
    processes = (await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n').filter(line => line.includes(cli) && line.includes(' serve ') && line.includes(project))
    if (processes.length === 1) break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(processes.length, 1, processes.join('\n'))
  assert.equal(Number(processes[0].trim().split(/\s+/)[0]), fileOwner.pid)
})

test('reboot recovery cancels an interrupted check without rerunning it or killing a reused PID', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-boot-check-'))
  const store = new RunStore(':memory:'); t.after(async () => { store.close(); await rm(project, { recursive: true, force: true }) })
  const directory = join(project, 'checks'), id = 'old-check'
  const record: ChecksRecord = { id, runId: 'run', taskId: 'task', dispatchId: 'dispatch', directory, stage: 'launched', pid: process.pid, bootId: 'previous-boot-fixture', nativeResult: {}, request: { version: 1, id, runId: 'run', taskId: 'task', token: 'fixture', cwd: project, commands: ['pwd'] } }
  store.put('native-checks:' + id, record)
  await atomicJson(join(directory, 'execution.lock'), { id, pid: process.pid, bootId: 'previous-boot-fixture' })
  await atomicJson(join(directory, 'started.json'), { id, pid: process.pid, bootId: 'previous-boot-fixture' })
  await atomicJson(join(directory, 'command-0.intent.json'), { id, index: 0, command: 'pwd', at: '' })
  await atomicJson(join(directory, 'command-0.child.json'), { id, index: 0, pid: process.pid, bootId: 'previous-boot-fixture' })
  const manager = new ChecksSupervisor(store, project)
  assert.equal((await manager.observe(record)).state, 'unknown')
  const result = await manager.cancel(record)
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.checks[0].exitCode, null)
  assert.match(result.checks[0].error!, /unknown/)
  assert.equal(store.events().some(event => event.kind === 'acceptance.launched'), false)
  process.kill(process.pid, 0)
})
