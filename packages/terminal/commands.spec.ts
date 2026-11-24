import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))

test('schema validation works without a configured model or a running Orca; run preflight still refuses unavailable backend', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-offline-validation-')); t.after(() => rm(project, { recursive: true, force: true }))
  await mkdir(join(project, '.agent-pipeline'))
  await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ backend: 'orca', orca: { executable: '/missing/orca-for-validation-test' }, executors: { pi: { kind: 'pi', provider: 'not-configured', model: 'missing' } } }))
  await writeFile(join(project, 'plan.pipeline.yaml'), 'name: offline\nobjective: Validate only\nsteps:\n  - id: audit\n    title: Audit\n    spec: Read\n    agent: pi\n    acceptance: [pwd]\n')
  const result = await exec(process.execPath, [cli, 'validate', '--project', project, '--file', 'plan.pipeline.yaml', '--json'])
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, scope: 'schema-and-graph', name: 'offline', steps: 1 })
  await assert.rejects(exec(process.execPath, [cli, 'run', '--project', project, '--file', 'plan.pipeline.yaml', '--json']), /missing\/orca-for-validation-test/)
})
