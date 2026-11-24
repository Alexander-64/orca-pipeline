import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { metricsForRuns } from './metrics'
import { demoRun } from './testData'

test('validates a scenario through the worker without starting a run', async () => {
  const host = mockHost({
    results: {
      'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('scenario.validate', {
    source: 'name: test\nobjective: test\nsteps:\n  - id: one\n    title: One\n    spec: Work\n    agent: codex\n    acceptance: [test]\n'
  })
  assert.equal(answer.scenario.steps[0].id, 'one')
  const { agents, projects, plans, modelCatalogs, modelCatalogState, unsupportedModelAgents, ...dashboard } = await worker.request('dashboard.get', {})
  assert.ok(agents?.some(agent => agent.id === 'codex'))
  assert.ok(['ready', 'unsupported', 'undiscovered'].includes(modelCatalogState!))
  assert.deepEqual(plans, [])
  assert.deepEqual(dashboard, {
    runs: [],
    runHistory: [],
    beads: [],
    beadsEnabled: false,
    workspaces: [],
    metrics: metricsForRuns([])
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('rejects an invalid scenario before touching Orca', async () => {
  const worker = await mountWorker(main)
  await assert.rejects(() => worker.request('scenario.validate', { source: 'name: broken' }), /steps/)
  await worker.deactivate()
})

test('restores persisted runs before answering the first dashboard request', async () => {
  const persisted = { ...demoRun, status: 'done' as const }
  const host = mockHost({
    storage: { 'pipeline.runs.v1': [persisted] },
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const dashboard = await worker.request('dashboard.get', {})
  assert.equal(dashboard.runs.length, 1)
  assert.equal(dashboard.runs[0].id, demoRun.id)
  assert.equal(dashboard.runs[0].status, 'done')
  await worker.deactivate()
})

test('restored failure details remain available with an orphaned visible launch receipt', async () => {
  const run = structuredClone(demoRun)
  run.status = 'failed'
  const task = run.tasks.build
  task.status = 'failed'
  task.error = 'Исполнитель завершился: unknown'
  task.attempts = [{ dispatchId: 'ctx_failed', agent: 'codex', status: 'failed', startedAt: run.createdAt, output: 'git diff --check failed: trailing whitespace' }]
  const launch = { requestId: 'pipeline-launch-' + '0'.repeat(32), args: ['agent', 'launch', '--agent', 'codex', '--worktree', 'path:/old'], status: 'pending' }
  const host = mockHost({
    storage: { 'pipeline.runs.v1': [run], 'pipeline.mutations.v1': [launch] },
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  try {
    const dashboard = await worker.request('dashboard.get', { selectedRunId: run.id })
    assert.equal(dashboard.recoveryWarning, undefined)
    assert.equal(dashboard.runs[0].tasks.build.error, 'git diff --check failed: trailing whitespace')
  } finally { await worker.deactivate() }
})

 test('restores completed planner source through plan.list after worker restart', async () => {
  const saved = { id: 'saved', runId: 'run', dispatchId: 'dispatch', agent: 'codex', status: 'done', workspaceId: 'workspace-1', source: 'saved source' }
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'pipeline.plans.v1': [saved] } }) })
  assert.deepEqual((await worker.request('plan.list', { workspaceId: 'workspace-1' })).plans, [saved])
  assert.deepEqual((await worker.request('plan.list', { workspaceId: 'other' })).plans, [])
  await worker.deactivate()
})

test('run navigation uses the stored workspace and refuses foreign dispatch ids', async () => {
  const host = mockHost({
    storage: { 'pipeline.runs.v1': [{ ...demoRun, status: 'done' }] },
    results: { 'workspace.open': { opened: true } }
  })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('run.open', { id: demoRun.id }), { opened: true })
  await assert.rejects(() => worker.request('run.open', { id: demoRun.id, dispatchId: 'foreign' }), /не принадлежит/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('opens a real YAML document with a relative host path and binds publishing to its project', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, relative, isAbsolute } = await import('node:path')
  const { DEFAULT_SCENARIO } = await import('./types')
  const directory = await mkdtemp(join(tmpdir(), 'pipeline-editor-'))
  const host = mockHost({ results: {
    'workspace.list': { workspaces: [{ id: 'folder:fixture', kind: 'folder', name: 'Fixture', path: directory, branch: null, hostId: 'local' }], truncated: false },
    'workspace.open': { opened: true }, 'editor.open': { opened: true }
  } })
  const worker = await mountWorker(main, { host })
  try {
    const { path } = await worker.request('editor.open', { workspaceId: 'folder:fixture', source: DEFAULT_SCENARIO })
    assert.match(await readFile(path, 'utf8'), /agent-pipeline-workspace: "folder:fixture"/)
    assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'folder:fixture', path: relative(directory, path) }])
    assert.equal(isAbsolute((host.callsOf('editor.open')[0] as { path: string }).path), false)
    await assert.rejects(() => worker.request('editor.publish', { source: DEFAULT_SCENARIO, workspaceId: 'foreign' }), /Откройте редактор/)
    assert.deepEqual(await worker.request('editor.publish', { source: DEFAULT_SCENARIO, workspaceId: 'folder:fixture' }), { ok: true })
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate(); await rm(directory, { recursive: true, force: true }) }
})

test('initialization recovers after a transient host refusal instead of caching rejection forever', async () => {
  let ready = false
  const host = mockHost({ results: {
    'settings.get': () => { if (!ready) throw new Error('plugin is not enabled with current consent'); return { settings: { pollIntervalMs: 2500 } } },
    'workspace.list': { workspaces: [], truncated: false }, 'agents.list': { agents: [] }
  } })
  const worker = await mountWorker(main, { host })
  await assert.rejects(() => worker.request('dashboard.get', {}), /consent/)
  ready = true
  const dashboard = await worker.request('dashboard.get', {})
  assert.deepEqual(dashboard.workspaces, [])
  await worker.deactivate()
})

test('run start rejects conflicting workspace placement before creating a terminal or workspace', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [{ id: 'source', kind: 'worktree', name: 'Source', path: '/source/specs', branch: 'main', hostId: null }], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const source = 'name: location\nobjective: Read\nsteps:\n - {id: a, title: A, spec: "Работай только в /source/specs.", agent: codex, acceptance: [pwd]}'
  await assert.rejects(() => worker.request('run.start', { workspaceId: 'source', source, separateWorkspace: true }), /разрешена работа только/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})


test('disabled Beads never probes an unavailable executable and refuses external mutations', async () => {
  const host = mockHost({
    settings: { beadsEnabled: false, beadsExecutable: '/missing/pipeline-test-bd' },
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [{
      id: 'workspace-test', kind: 'folder', name: 'Test', path: '/tmp', branch: null, hostId: 'local'
    }], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const dashboard = await worker.request('dashboard.get', { workspaceId: 'workspace-test' })
  assert.equal(dashboard.beadsEnabled, false)
  assert.equal(dashboard.beadsError, undefined)
  assert.deepEqual(dashboard.beads, [])
  await assert.rejects(() => worker.request('beads.action', { workspaceId: 'workspace-test', id: 'bd-test', action: 'close' }), /Интеграция Beads выключена/)
  await worker.deactivate()
})

test('enabled but unavailable Beads reports optional connection failure without blocking the dashboard', async () => {
  const worker = await mountWorker(main, { host: mockHost({
    settings: { beadsEnabled: true, beadsExecutable: '/missing/pipeline-test-bd' },
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [{
      id: 'workspace-test', kind: 'folder', name: 'Test', path: '/tmp', branch: null, hostId: 'local'
    }], truncated: false } }
  }) })
  const dashboard = await worker.request('dashboard.get', { workspaceId: 'workspace-test' })
  assert.equal(dashboard.beadsEnabled, true)
  assert.match(dashboard.beadsError ?? '', /ENOENT|missing/)
  assert.deepEqual(dashboard.beads, [])
  await worker.deactivate()
})


test('an unconfirmed agent launch cannot hide saved history or resume saved workers', async () => {
  const running = structuredClone(demoRun)
  const completed = { ...structuredClone(demoRun), id: 'completed-in-another-project', workspaceId: 'old-project', status: 'done' as const }
  const host = mockHost({ storage: {
    'pipeline.runs.v1': [running, completed],
    'pipeline.mutations.v1': [{ requestId: 'unconfirmed-launch', args: ['agent', 'launch', '--agent', 'codex'], status: 'pending' }]
  }, results: {
    'agents.list': { agents: [] },
    'workspace.list': { workspaces: [{ id: 'different-project', kind: 'folder', name: 'Different', path: '/tmp', branch: null, hostId: 'local' }], truncated: false }
  } })
  const worker = await mountWorker(main, { host })
  const dashboard = await worker.request('dashboard.get', { workspaceId: 'different-project' })
  assert.deepEqual(dashboard.runs, [])
  assert.equal(dashboard.runHistory?.length, 2)
  assert.ok(dashboard.runHistory?.some(run => run.id === running.id && run.status === 'running'))
  assert.match(dashboard.recoveryWarning ?? '', /unconfirmed receipt/)
  await assert.rejects(() => worker.request('run.retry', { id: running.id }), /unconfirmed receipt/)
  assert.deepEqual(host.data().storage['pipeline.runs.v1'], [running, completed])
  await worker.deactivate()
})

test('repair reports an unresolved resource instead of silently dropping its receipt', async () => {
  const paused = structuredClone(demoRun); paused.status = 'paused'
  const pending = { requestId: 'unmatched-launch', args: ['agent', 'launch', '--agent', 'codex'], status: 'pending' }
  const host = mockHost({ storage: { 'pipeline.runs.v1': [paused, { ...paused, id: 'healthy', runId: 'other', status: 'running' }], 'pipeline.mutations.v1': [pending] }, results: {
    'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }
  } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('run.repair', { id: paused.id })
  assert.equal(answer.report.status, 'blocked')
  assert.ok(answer.report.messages.some(message => message.includes('не сопоставлена')))
  assert.equal(answer.dashboard.runHistory?.find(run => run.id === 'healthy')?.status, 'running')
  assert.deepEqual(host.data().storage['pipeline.mutations.v1'], [pending])
  assert.equal((host.data().storage['pipeline.recovery.v1'] as { status: string }).status, 'blocked')
  await worker.deactivate()
})
