import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { BeadsClient } from './beads'
import { defaultRunner } from './cli'
import { parseScenario } from './scenario'
import type { PipelineRun, PipelineTask } from './types'

test('creates, lists, updates and closes a real Beads issue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-pipeline-beads-'))
  const executable = join(process.cwd(), 'node_modules', '.bin', 'bd')
  try {
    const repository = await defaultRunner('git', ['init', '--quiet', '--template='], directory)
    assert.equal(repository.code, 0, repository.stderr)
    const initialized = await defaultRunner(executable, ['init', '--prefix', 'ap', '--quiet', '--stealth', '--skip-agents', '--skip-hooks'], directory)
    assert.equal(initialized.code, 0, initialized.stderr)
    const client = new BeadsClient(directory, defaultRunner, executable)
    const step = parseScenario(`name: test
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`).steps[0]
    const beadId = await client.create('run_test', step, [])
    assert.ok(beadId.startsWith('ap-'))
    assert.equal((await client.list()).length, 1)
    const run = { runId: 'run_test' } as PipelineRun
    const task: PipelineTask = { stepId: step.id, taskId: 'task_test', beadId, status: 'running', agent: 'codex', attempts: [] }
    await client.sync(run, task)
    assert.equal((await client.list())[0].status, 'in_progress')
    await client.comment(beadId, 'checkpoint')
    task.status = 'done'
    await client.sync(run, task)
    assert.equal((await client.list())[0].status, 'closed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
