import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PipelineRun } from '../core/types'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))
test('a real Pi SDK HTTP 401 becomes an auth failure without acceptance or provider fallback', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-pi-auth-'))
  const agentDir = join(project, 'isolated-pi-settings')
  await mkdir(agentDir); await mkdir(join(project, '.agent-pipeline'))
  let requests = 0
  const server = createServer((request, response) => {
    requests++; request.resume()
    response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Invalid API key (local fault fixture)', type: 'authentication_error', code: 'invalid_api_key' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'public-test-value', models: [{ id: 'fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024 }] } } }))
  await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { fault: { kind: 'pi', provider: 'fixture', model: 'fixture' }, backup: { kind: 'jsonl', executable: process.execPath } } }))
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
  const call = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '-C', project, '--json'], { env, timeout: 25000 })).stdout)
  t.after(async () => {
    try { const { runs } = await call('status') as { runs: PipelineRun[] }; for (const run of runs) if (!['done', 'cancelled'].includes(run.status)) await call('stop', '--run', run.id); await call('shutdown') }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(project, { recursive: true, force: true }) }
  })
  await writeFile(join(project, 'plan.yaml'), 'name: auth-fault\nobjective: Verify transport classification\ncommandPolicy: {readOnly: true}\nsteps:\n - {id: audit, title: Audit, spec: Return a short answer, agent: fault, fallback: [backup], acceptance: [pwd]}\n')
  const started = await call('run', '-f', 'plan.yaml') as PipelineRun
  const deadline = Date.now() + 15000
  let current: PipelineRun
  do {
    assert.ok(Date.now() < deadline, 'Auth actor did not settle')
    await new Promise(resolve => setTimeout(resolve, 100))
    current = (await call('status', '--run', started.id)).runs[0]
  } while (current.status === 'running')
  assert.equal(current.status, 'failed')
  assert.equal(current.tasks.audit.attempts.length, 1)
  assert.equal(current.tasks.audit.attempts[0].failure?.phase, 'executor')
  assert.equal(current.tasks.audit.attempts[0].failure?.kind, 'auth')
  assert.deepEqual(current.tasks.audit.attempts[0].checks, [])
  assert.equal(requests, 1)
})
