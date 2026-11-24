import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { request } from './supervisor'
import { RunStore } from './store'
import type { PipelineRun } from '../core/types'
import type { ChecksRecord } from './checks'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))
const fake = fileURLToPath(new URL('./fixtures/orca.mjs', import.meta.url))
const node = (code: string) => process.execPath + ' -e ' + JSON.stringify(code)
const absent = (pid: number, group = false) => { try { process.kill(group ? -pid : pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }
async function until(check: () => Promise<boolean> | boolean, timeout = 20000) { const end = Date.now() + timeout; while (!await check()) { assert.ok(Date.now() < end, 'Observation deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 40)) } }

async function setup(t: { after(fn: () => Promise<void>): void }, commands: string[]) {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-supervisor-'))
  await mkdir(join(project, '.agent-pipeline'))
  const executable = join(project, 'orca.mjs'); await copyFile(fake, executable); await chmod(executable, 0o755)
  await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ backend: 'orca', executors: { codex: { kind: 'codex' }, backup: { kind: 'codex' } }, orca: { executable, visibleWorkers: false } }))
  const command = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '-C', project, '--json'], { timeout: 25000 })).stdout)
  const call = (name: string, runId?: string, timeout = 20000) => request(project, { id: randomUUID(), command: name, runId }, timeout)
  const records = () => { const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'), true); try { return store.list<ChecksRecord>('native-checks:') } finally { store.close() } }
  t.after(async () => {
    try {
      await command('status')
      const state = await call('status') as { runs: PipelineRun[] }
      for (const run of state.runs.filter(run => ['running', 'paused', 'failed'].includes(run.status))) {
        try { await call('stop', run.id) } catch {
          // Only unfinished command groups recorded in this test's private project.
          for (const record of records().filter(record => !record.result && record.request.cwd === project)) {
            for (let index = 0; index < record.request.commands.length; index++) {
              const child = await readFile(join(record.directory, `command-${index}.child.json`), 'utf8').then(JSON.parse, () => undefined)
              if (child?.id === record.id && !absent(child.pid, true)) process.kill(-child.pid, 'SIGKILL')
            }
          }
          await call('stop', run.id)
        }
      }
      await call('shutdown'); await new Promise(resolve => setTimeout(resolve, 150))
    } finally { await rm(project, { recursive: true, force: true }) }
  })
  await command('status')
  const source = `version: 2\nname: native-checks\nobjective: Test durable acceptance\ncommandPolicy: {readOnly: false}\nsteps:\n - id: audit\n   title: Audit\n   agent: codex\n   fallback: [backup]\n   spec: Native fixture\n   acceptance: ${JSON.stringify(commands)}\n`
  const requestId = randomUUID()
  const run = await request(project, { id: requestId, command: 'run', source }) as PipelineRun
  const current = async () => (await call('status', run.id) as { runs: PipelineRun[] }).runs[0]
  return { project, run, command, call, records, current, requestId }
}

test('killing the native supervisor preserves a running acceptance actor and never repeats its command', async t => {
  const h = await setup(t, [node("require('node:fs').appendFileSync('count.txt','x'),setTimeout(function(){},2500)"), 'pwd'])
  await until(() => readFile(join(h.project, 'count.txt')).then(() => true, () => false))
  const actor = JSON.parse(await readFile(join(h.records()[0].directory, 'started.json'), 'utf8'))
  const { pid } = await h.call('ping') as { pid: number }
  process.kill(pid, 'SIGKILL') // Supervisor created by this test, not the acceptance actor.
  await until(() => absent(pid))
  assert.equal(absent(actor.pid), false, 'Acceptance actor must survive its supervisor')
  await h.command('status')
  await until(async () => (await h.current()).status === 'done')
  const run = await h.current()
  assert.equal(run.tasks.audit.attempts.length, 1)
  assert.equal(run.tasks.audit.attempts[0].dispatchId, h.run.tasks.audit.attempts[0].dispatchId)
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
  assert.equal(h.records().length, 1)
  assert.ok(run.tasks.audit.attempts[0].checks?.every(check => check.exitCode === 0))
})

test('native acceptance keeps ping responsive and stop confirms cancellation with the partial checks and report', async t => {
  const h = await setup(t, ['pwd', node("require('node:fs').writeFileSync('running','yes'),setTimeout(function(){},30000)")])
  await until(() => readFile(join(h.project, 'running')).then(() => true, () => false))
  await h.call('ping', undefined, 1000)
  await assert.rejects(request(h.project, { id: h.requestId, command: 'stop', runId: h.run.id }), /different arguments/)
  await assert.rejects(readFile(join(h.records()[0].directory, 'cancel.json')), { code: 'ENOENT' })
  const stopped = await h.call('stop', h.run.id, 5000) as PipelineRun
  assert.equal(stopped.status, 'cancelled')
  const attempt = stopped.tasks.audit.attempts[0]
  assert.equal(attempt.failure?.phase, 'cancellation'); assert.equal(attempt.checks?.[0].exitCode, 0)
  assert.equal(attempt.checks?.[1].exitCode, null); assert.match(attempt.output!, /Native fixture worker report/)
  const native = JSON.parse(await readFile(join(h.project, 'fake-orca-state.json'), 'utf8'))
  assert.equal(native.starts, 1)
})

test('an interrupted native acceptance pauses the run and rejects resume/retry until cancellation is proven', async t => {
  const h = await setup(t, ['pwd', node("require('node:fs').appendFileSync('count.txt','x'),setTimeout(function(){},30000)")])
  await until(() => readFile(join(h.project, 'count.txt')).then(() => true, () => false))
  const record = h.records()[0]
  const actor = JSON.parse(await readFile(join(record.directory, 'started.json'), 'utf8'))
  const child = JSON.parse(await readFile(join(record.directory, 'command-1.child.json'), 'utf8'))
  process.kill(actor.pid, 'SIGKILL')
  await until(async () => (await h.current()).tasks.audit.unconfirmedChecks === true)
  assert.equal((await h.current()).status, 'paused')
  await assert.rejects(h.call('resume', h.run.id), /unknown command outcome/)
  await assert.rejects(h.call('retry', h.run.id), /unconfirmed start\/acceptance/)
  await assert.rejects(h.call('stop', h.run.id), /cancellation unconfirmed/)
  assert.equal((await h.current()).status, 'paused')
  assert.equal(await readFile(join(h.project, 'count.txt'), 'utf8'), 'x')
  process.kill(-child.pid, 'SIGKILL') // This test's verified command group; no arbitrary PID cancellation.
  await until(() => absent(child.pid, true))
  const stopped = await h.call('stop', h.run.id) as PipelineRun
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.tasks.audit.unconfirmedChecks, undefined)
  assert.equal(stopped.tasks.audit.attempts[0].checks?.[0].exitCode, 0)
  assert.equal(stopped.tasks.audit.attempts.length, 1)
})
