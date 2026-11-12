import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { ArtifactStore } from './artifacts'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { parseScenario } from './scenario'

test('writes a redacted artifact with safe paths and attempt metadata', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.artifact-smoke-'))
  try {
    const h = coordinatorFixture({ artifacts: new ArtifactStore(directory) })
    const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: artifacts
objective: artifacts
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`))
    run.tasks.build.attempts[0].output = 'api_key=very-secret'
    h.statuses.set('task_build', 'completed')
    await h.coordinator.tick(run.id)
    const attempt = run.tasks.build.attempts[0]
    assert.ok(attempt.artifactPath)
    assert.ok(attempt.artifactPath!.startsWith('.agent-pipeline/artifacts/'))
    const content = JSON.parse(await readFile(join(directory, attempt.artifactPath!), 'utf8'))
    assert.equal(content.version, 1)
    assert.equal(content.dispatchId, 'dispatch_1')
    assert.ok(!content.output.includes('very-secret'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bounds artifact output size', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.artifact-smoke-'))
  try {
    const h = coordinatorFixture({ artifacts: new ArtifactStore(directory) })
    const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: artifacts
objective: artifacts
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`))
    run.tasks.build.attempts[0].output = 'x'.repeat(100_000)
    h.statuses.set('task_build', 'completed')
    await h.coordinator.tick(run.id)
    const content = await readFile(join(directory, run.tasks.build.attempts[0].artifactPath!), 'utf8')
    assert.ok(content.length < 80_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('sanitizes run, step and dispatch identifiers', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.artifact-smoke-'))
  try {
    const h = coordinatorFixture({ artifacts: new ArtifactStore(directory) })
    const run = await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: artifacts
objective: artifacts
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`))
    run.runId = '../../outside'
    run.scenario.steps[0].id = '../../step'
    run.tasks.build.stepId = '../../step'
    await new ArtifactStore(directory).save(run, run.tasks.build, run.tasks.build.attempts[0])
    assert.ok(!run.tasks.build.attempts[0].artifactPath!.split('/').includes('..'))
    assert.ok(run.tasks.build.attempts[0].artifactPath!.startsWith('.agent-pipeline/'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
