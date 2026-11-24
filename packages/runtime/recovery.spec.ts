import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { LocalBackend, verifiedProcessExit } from './backend'
import { RunStore } from './store'
import { atomicJson } from './files'
import type { WorkerRequest } from './worker-main'

async function fixture(run: (h: { backend: LocalBackend; store: RunStore; directory: string; project: string; launches: WorkerRequest[]; exitedPid: number }) => Promise<void>) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-recovery-')))
  const store = new RunStore(join(project, 'state.sqlite'))
  const directory = join(project, 'attempt')
  await mkdir(join(directory, 'sessions'), { recursive: true })
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise(resolve => child.once('exit', resolve))
  const exitedPid = child.pid!
  const launches: WorkerRequest[] = []
  class Backend extends LocalBackend {
    protected override async spawnWorker(path: string) {
      assert.equal(store.get<any>('attempt:a').recovery.state, 'intent')
      launches.push(JSON.parse(await readFile(path, 'utf8')))
    }
  }
  const backend = new Backend(store, project, { executors: { pi: { kind: 'pi' } } })
  const session = join(directory, 'sessions', 'history.jsonl')
  await writeFile(session, JSON.stringify({ type: 'session', cwd: project, id: 'history' }) + '\n')
  await atomicJson(join(directory, 'session.json'), { id: 'a', file: session })
  await atomicJson(join(directory, 'phase.json'), { id: 'a', phase: 'agent' })
  await atomicJson(join(directory, 'started.json'), { id: 'a', pid: exitedPid })
  await atomicJson(join(directory, 'request.json'), { id: 'a', cwd: project, executor: { kind: 'pi' }, prompt: 'Original task', cancelToken: 't', acceptance: ['pwd'] })
  store.put('attempt:a', { id: 'a', taskId: 'task', runId: 'run', directory, agent: 'pi', cancelToken: 't', startedAt: '2026-11-13T00:00:00Z', stage: 'launched', eventSeq: 0 })
  store.put('task:task', { id: 'task', attempt: 'a', status: 'dispatched' })
  try { await run({ backend, store, directory, project, launches, exitedPid }) }
  finally { store.close(); await rm(project, { recursive: true, force: true }) }
}

test('context recovery retains the attempt and session, journals before spawn and refuses an ambiguous second launch', async () => fixture(async h => {
  assert.equal(verifiedProcessExit(h.exitedPid), true)
  assert.equal(verifiedProcessExit(process.pid), false)
  assert.equal(verifiedProcessExit(0), false)
  await writeFile(join(h.directory, 'events.jsonl'), '{"seq":1,"id":"a","kind":"worker.started"}\n{"seq":2,')
  await mkdir(join(h.directory, 'questions'))
  await atomicJson(join(h.directory, 'questions', 'q.json'), { id: 'q', question: 'Still waiting?', state: 'waiting' })
  assert.equal((await h.backend.workerObservation('a')).activity, 'interrupted')
  await h.backend.recoverPi('a')
  assert.equal(h.launches.length, 1)
  assert.equal(h.launches[0].id, 'a')
  assert.equal(h.launches[0].generation, 1)
  assert.equal(h.launches[0].resumeSessionFile, join(h.directory, 'sessions/history.jsonl'))
  assert.match(h.launches[0].prompt, /Original task/)
  assert.equal(h.store.get<any>('attempt:a').recovery.state, 'launched')
  assert.equal(JSON.parse(await readFile(join(h.directory, 'questions/q.json'), 'utf8')).state, 'cancelled')
  assert.ok((await readFile(join(h.directory, 'events.jsonl'), 'utf8')).endsWith('\n'))
  assert.deepEqual(JSON.parse(await readFile(join(h.directory, 'interrupted-event-tail-1.json'), 'utf8')), { text: '{"seq":2,' })
  await assert.rejects(h.backend.recoverPi('a'), /exit is not verified/)
  assert.equal(h.launches.length, 1)
}))

test('live PID, foreign session and acceptance phase each prevent context recovery', async () => fixture(async h => {
  await atomicJson(join(h.directory, 'started.json'), { id: 'a', pid: process.pid })
  await assert.rejects(h.backend.recoverPi('a'), /exit is not verified/)
  await atomicJson(join(h.directory, 'started.json'), { id: 'a', pid: h.exitedPid })
  await atomicJson(join(h.directory, 'phase.json'), { id: 'a', phase: 'acceptance' })
  await assert.rejects(h.backend.recoverPi('a'), /acceptance/)
  await atomicJson(join(h.directory, 'phase.json'), { id: 'a', phase: 'agent' })
  const foreign = join(h.project, 'foreign.jsonl')
  await writeFile(foreign, '{"type":"session"}\n')
  await atomicJson(join(h.directory, 'session.json'), { id: 'a', file: foreign })
  await assert.rejects(h.backend.recoverPi('a'), /outside the attempt/)
  assert.equal(h.launches.length, 0)
}))

test('settled workers and requested cancellations are never resumed', async () => fixture(async h => {
  await atomicJson(join(h.directory, 'cancel.json'), { id: 'a', token: 't' })
  await assert.rejects(h.backend.recoverPi('a'), /Cancellation/)
  h.store.put('attempt:a', { ...h.store.get<any>('attempt:a'), result: { id: 'a', outcome: 'succeeded' } })
  await assert.rejects(h.backend.recoverPi('a'), /already settled/)
  assert.equal(h.launches.length, 0)
}))

test('a verified-dead controlled Pi actor can be cancelled without repeating work or waiting forever', async () => fixture(async h => {
  await h.backend.stopWorker('a')
  assert.equal(h.launches.length, 0)
  assert.equal(h.store.get<any>('attempt:a').result.outcome, 'cancelled')
  assert.equal(h.store.get<any>('task:task').status, 'failed')
  await assert.rejects(h.backend.recoverPi('a'), /already settled/)
}))
