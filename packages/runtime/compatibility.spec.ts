import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
import { RunStore, stateVersion } from './store'
import { request, socketPath, IncompatibleRuntimeError } from '../core/terminal-ipc'

for (const oldVersion of [1, 2, 3]) test(`state v${oldVersion} migration preserves snapshots, receipts and event sequence; old readers are fenced`, async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-state-upgrade-')); t.after(() => rm(project, { recursive: true, force: true }))
  const file = join(project, 'state.sqlite')
  const initial = new RunStore(file)
  initial.put('run:legacy', { id: 'legacy', status: 'paused' })
  initial.put('request:one', { state: 'done', result: 'existing' })
  initial.eventOnce('stable-receipt', 'once', { done: true }); initial.close()
  const legacy = new DatabaseSync(file); legacy.prepare('UPDATE metadata SET version=?').run(oldVersion); legacy.close()
  const reader = new RunStore(file, true); assert.equal(reader.get<{ status: string }>('run:legacy')?.status, 'paused'); reader.close()
  const current = new RunStore(file)
  assert.deepEqual(current.get('request:one'), { state: 'done', result: 'existing' })
  current.eventOnce('stable-receipt', 'once', { done: true })
  const events = current.events()
  assert.equal(events.filter(event => event.kind === 'once').length, 1)
  assert.equal(events.filter(event => event.kind === 'state.migrated').length, 1)
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4]); current.close()
  const probe = new DatabaseSync(file)
  assert.equal(probe.prepare('SELECT version FROM metadata').get()?.version, stateVersion)
  probe.exec('UPDATE metadata SET version=99'); probe.close()
  assert.throws(() => new RunStore(file), /Unsupported state version: 99/)
  const unchanged = new DatabaseSync(file); assert.equal(unchanged.prepare('SELECT version FROM metadata').get()?.version, 99); unchanged.close()
})

test('new client refuses an old supervisor before sending any mutation', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-old-runtime-')))
  const commands: string[] = []
  const server = createServer(connection => {
    let buffer = ''
    connection.on('data', chunk => {
      buffer += chunk.toString()
      if (!buffer.includes('\n')) return
      const message = JSON.parse(buffer.split('\n')[0]); commands.push(message.command)
      connection.end(JSON.stringify({ ok: true, result: { version: 1 } }) + '\n')
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath(project), resolve))
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(project, { recursive: true, force: true }) })
  await assert.rejects(request(project, { id: 'control', command: 'run', source: 'version: 2' }), IncompatibleRuntimeError)
  assert.deepEqual(commands, ['ping'])
})
