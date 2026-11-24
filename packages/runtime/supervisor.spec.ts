import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { realpath } from 'node:fs/promises'
import { request, serve, socketPath, type Request } from './supervisor'
import { createBackend } from './factory'
import type { PipelineRun } from '../core/types'
import { RunStore } from './store'
import { parseScenario } from '../core/scenario'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/executor.mjs', import.meta.url))

async function setup(t: { after(fn: () => Promise<void>): void }, delay = 300) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-supervisor-'))
  await mkdir(join(project, '.agent-pipeline'))
  await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { fixture: { kind: 'jsonl', executable: process.execPath, args: [fixture, String(delay)] } } }))
  const source = 'name: supervised\nobjective: Test recovery\ncommandPolicy: {readOnly: true}\nsteps:\n  - id: audit\n    title: Audit\n    spec: Analyze\n    agent: fixture\n    acceptance: [pwd]\n'
  const call = async (message: Omit<Request, 'id'> & { id?: string }) => request(project, { id: randomUUID(), ...message })
  const command = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '--project', project, '--json'], { timeout: 25_000 })).stdout)
  await command('status')
  t.after(async () => {
    try {
      const { runs } = await call({ command: 'status' }) as { runs: PipelineRun[] }
      for (const run of runs) if (['running', 'paused', 'failed'].includes(run.status)) await call({ command: 'stop', runId: run.id })
      await call({ command: 'shutdown' })
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally { await rm(project, { recursive: true, force: true }) }
  })
  return { project, source, call, command }
}

async function finished(call: (message: { command: string }) => Promise<unknown>): Promise<PipelineRun> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const { runs } = await call({ command: 'status' }) as { runs: PipelineRun[] }
    if (runs[0]?.status === 'done') return runs[0]
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Run did not finish')
}

test('two clients replay one run request and mismatched reuse is rejected', async t => {
  const h = await setup(t)
  const message = { id: randomUUID(), command: 'run', source: h.source }
  const [a, b] = await Promise.all([h.call(message), h.call(message)]) as PipelineRun[]
  assert.equal(a.id, b.id)
  await assert.rejects(h.call({ ...message, source: h.source.replace('Analyze', 'Different') }), /different arguments/)
  const result = await finished(h.call)
  assert.equal(result.tasks.audit.attempts.length, 1)
})

test('current supervisor rejects an old client control before recording or starting a run', async t => {
  const h = await setup(t)
  const result = await new Promise<{ ok: boolean; error: string }>(async (resolve, reject) => {
    const connection = createConnection(socketPath(await realpath(h.project)))
    let buffer = ''
    connection.on('error', reject)
    connection.on('connect', () => connection.write(JSON.stringify({ id: 'legacy-control', command: 'run', source: h.source, protocol: 1 }) + '\n'))
    connection.on('data', chunk => { buffer += chunk.toString(); if (buffer.includes('\n')) { connection.end(); resolve(JSON.parse(buffer.split('\n')[0])) } })
  })
  assert.equal(result.ok, false); assert.match(result.error, /Incompatible client protocol/)
  assert.deepEqual((await h.call({ command: 'status' }) as { runs: PipelineRun[] }).runs, [])
})

test('killed supervisor recovers an orphan worker receipt without a second attempt', async t => {
  const h = await setup(t, 1200)
  const run = await h.call({ command: 'run', source: h.source }) as PipelineRun
  const { pid } = await h.call({ command: 'ping' }) as { pid: number }
  process.kill(pid, 'SIGKILL') // Only the supervisor created by this test.
  await new Promise(resolve => setTimeout(resolve, 100))
  await h.command('status')
  const result = await finished(h.call)
  assert.equal(result.id, run.id)
  assert.equal(result.tasks.audit.attempts.length, 1)
  assert.equal(result.tasks.audit.attempts[0].dispatchId, run.tasks.audit.attempts[0].dispatchId)
})

test('stop waits for a durable cancellation receipt before reporting cancelled', async t => {
  const h = await setup(t, 8000)
  const run = await h.call({ command: 'run', source: h.source }) as PipelineRun
  const stopped = await h.call({ command: 'stop', runId: run.id }) as PipelineRun
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.tasks.audit.attempts[0].reason, 'cancelled')
  assert.equal(stopped.tasks.audit.activity, 'stopped')
  const attempt = stopped.tasks.audit.attempts[0]
  assert.equal(attempt.failure?.phase, 'cancellation')
  assert.ok(attempt.output?.trim())
  const artifact = JSON.parse(await readFile(join(h.project, attempt.artifactPath!), 'utf8'))
  assert.equal(artifact.status, 'failed'); assert.equal(artifact.failure.phase, 'cancellation')
  const result = await h.call({ command: 'status' }) as { runs: PipelineRun[] }
  assert.equal(result.runs[0].tasks.audit.attempts.length, 1)
})

test('cancellation during acceptance preserves the completed report and earlier checks', async t => {
  const h = await setup(t, 5)
  const source = h.source.replace('readOnly: true', 'readOnly: false').replace('acceptance: [pwd]', 'acceptance: [pwd, ' + JSON.stringify(process.execPath + ' -e "setTimeout(function(){},20000)"') + ']')
  const run = await h.call({ command: 'run', source }) as PipelineRun
  const directory = join(h.project, '.agent-pipeline/runtime/attempts', run.tasks.audit.attempts[0].dispatchId)
  const deadline = Date.now() + 10000
  while (true) {
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8').catch(() => '')
    if (events.includes('acceptance.finished') && events.includes('setTimeout')) break
    assert.ok(Date.now() < deadline, 'Acceptance did not start')
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  const stopped = await h.call({ command: 'stop', runId: run.id }) as PipelineRun
  const attempt = stopped.tasks.audit.attempts[0]
  assert.equal(stopped.status, 'cancelled')
  assert.equal(attempt.checks?.[0].exitCode, 0)
  assert.match(attempt.output!, /Fixture report/)
  assert.equal(attempt.failure?.phase, 'cancellation')
  const artifact = JSON.parse(await readFile(join(h.project, attempt.artifactPath!), 'utf8'))
  assert.equal(artifact.checks[0].exitCode, 0); assert.match(artifact.output, /Fixture report/)
})

test('failed startup reconciliation leaves a reachable paused run and refuses unverified control actions', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-reconcile-blocked-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const scenario = parseScenario('name: broken\nobjective: Test\nsteps:\n - id: audit\n   title: Audit\n   agent: fixture\n   spec: Inspect\n   acceptance: [pwd]\n')
  const run: PipelineRun = { id: 'broken-run', runId: 'local-native', workspaceId: 'folder:' + project, workspacePath: project, coordinatorHandle: 'owner', scenario,
    tasks: { audit: { stepId: 'audit', taskId: 'task', agent: 'fixture', status: 'pending', attempts: [] } }, status: 'running', createdAt: '', updatedAt: '' }
  store.put('run:' + run.id, run)
  store.put('task:task', { id: 'task', runId: run.runId, attempt: 'missing-receipt', status: 'dispatched' })
  store.close()
  let pid: number | undefined
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await new Promise(resolve => setTimeout(resolve, 100)); await rm(project, { recursive: true, force: true })
  })
  const result = JSON.parse((await exec(process.execPath, [cli, 'status', '--project', project, '--json'], { timeout: 25_000 })).stdout)
  pid = (await request(project, { id: randomUUID(), command: 'ping' }) as { pid: number }).pid
  assert.equal(result.runs[0].status, 'paused')
  assert.match(result.runs[0].error, /missing attempt receipt/)
  for (const command of ['resume', 'retry', 'stop']) await assert.rejects(request(project, { id: randomUUID(), command, runId: run.id }), /reconciliation is incomplete/)
  await assert.rejects(request(project, { id: randomUUID(), command: 'reconcile', runId: run.id }), /missing attempt receipt/)
  assert.equal((await request(project, { id: randomUUID(), command: 'status' }) as { runs: PipelineRun[] }).runs[0].status, 'paused')
})

test('status and ping remain responsive during a slow start; queued pause prevents later launches', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-responsive-'))
  await mkdir(join(project, '.agent-pipeline'))
  await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { fixture: { kind: 'jsonl', executable: process.execPath, args: [fixture, '1000'] } } }))
  let entered!: () => void, release!: () => void
  const starting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  await serve(project, { backend: (store, root, config) => {
    const backend = createBackend(store, root, config), start = backend.startWorker.bind(backend)
    backend.startWorker = async (...args) => { entered(); await gate; return start(...args) }
    return backend
  } })
  const call = (command: string, runId?: string, timeout?: number) => request(project, { id: randomUUID(), command, runId }, timeout)
  t.after(async () => {
    release()
    try {
      const state = await call('status') as { runs: PipelineRun[] }
      for (const run of state.runs) if (['running', 'paused'].includes(run.status)) await call('stop', run.id)
      await call('shutdown'); await new Promise(resolve => setTimeout(resolve, 150))
    } finally { await rm(project, { recursive: true, force: true }) }
  })
  const source = 'name: responsive\nobjective: Test\ncommandPolicy: {readOnly: true}\nsteps:\n - {id: first, title: First, agent: fixture, spec: Inspect, acceptance: [pwd]}\n - {id: second, title: Second, agent: fixture, spec: Inspect independently, acceptance: [pwd]}\n'
  const launched = request(project, { id: randomUUID(), command: 'run', source }) as Promise<PipelineRun>
  await starting
  const snapshot = await call('status', undefined, 1000) as { runs: PipelineRun[] }
  const id = snapshot.runs[0].id
  assert.equal(snapshot.runs[0].tasks.first.activity, 'starting')
  assert.equal((await call('ping', undefined, 1000) as { pid: number }).pid, process.pid)
  const paused = call('pause', id)
  // A status round trip confirms the pause request has reached the same server before release.
  await call('status', id)
  release()
  await launched
  assert.equal((await paused as PipelineRun).status, 'paused')
  const final = await call('status', id) as { runs: PipelineRun[] }
  assert.equal(final.runs[0].tasks.first.attempts.length, 1)
  assert.equal(final.runs[0].tasks.second.attempts.length, 0)
})
