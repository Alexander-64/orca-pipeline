import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from './store'
import { OrcaBackend } from './orca-backend'
import { Coordinator } from '../core/coordinator'
import { parseScenario } from '../core/scenario'
import type { CommandRunner } from '../../src/cli'
import type { PipelineRun } from '../core/types'

const source = 'name: native\nobjective: Audit\ncommandPolicy: {readOnly: true}\nsteps:\n  - id: audit\n    title: Audit\n    spec: Read source\n    agent: codex\n    acceptance: [pwd]\n'
async function settle(coordinator: Coordinator, run: PipelineRun) {
  const deadline = Date.now() + 10000
  while (run.status === 'running') { assert.ok(Date.now() < deadline, JSON.stringify(run)); await coordinator.tick(run.id); await new Promise(resolve => setTimeout(resolve, 25)) }
}

function fakeOrca() {
  const calls: string[][] = []
  let started = false
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args)
    let result: unknown = {}
    const command = args.slice(0, 2).join(' ')
    if (args[0] === 'status') result = { runtime: { state: 'ready', capabilities: ['orchestration.contract.v1', 'orchestration.worker-launch-preferences.v1', 'orchestration.worker-stop-verdict.v1'] } }
    if (command === 'worktree show') result = { worktree: { path: args[args.indexOf('--worktree') + 1].replace(/^path:/, ''), address: { environment: 'local', worktree: 'identity:exact-project' } } }
    if (command === 'terminal create') result = { terminal: { id: 'term_coordinator' } }
    if (command === 'orchestration run-create') result = { run: { id: 'run_native' } }
    if (command === 'orchestration task-create') result = { task: { id: 'task_native' } }
    if (command === 'orchestration worker-start') { started = true; result = { dispatch: { id: 'dispatch_native' } } }
    if (command === 'orchestration task-list') result = { tasks: [{ id: 'task_native', status: started ? 'completed' : 'ready', result: JSON.stringify({ provenance: 'worker_report', outcome: 'succeeded', body: 'Agent says done', filesModified: [], checks: [{ command: 'invented', exitCode: 0 }] }) }] }
    if (command === 'orchestration worker-read') result = { text: 'Independent native report' }
    if (command === 'orchestration worker-show') result = { dispatch: { id: 'dispatch_native', taskId: 'task_native', runId: 'run_native' }, worker: { state: 'succeeded', effects: [{ kind: 'dispatch_input', state: 'accepted' }] } }
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  }
  return { runner, calls }
}

test('native executor aliases resolve to the configured agent rather than the profile name', async t => {
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca()
  const backend = new OrcaBackend(store, '/tmp', { executors: { reviewer: { kind: 'codex', model: 'configured-model' } }, orca: { visibleWorkers: false } }, fake.runner)
  const coordinator = new Coordinator({ client: backend, save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  await coordinator.start({ id: 'folder:/tmp', kind: 'folder', name: 'test', path: '/tmp', branch: null, hostId: null }, 'owner', parseScenario(source.replace('agent: codex', 'agent: reviewer')))
  const start = fake.calls.find(args => args[1] === 'worker-start')!
  assert.equal(start[start.indexOf('--agent') + 1], 'codex')
  assert.equal(start[start.indexOf('--model') + 1], 'configured-model')
})

test('unsupported local executors and missing launch capabilities fail native preflight before Run creation', async t => {
  const store = new RunStore(':memory:'); t.after(() => store.close())
  for (const executor of [{ kind: 'pi' as const }, { kind: 'jsonl' as const, executable: process.execPath }, { kind: 'orca' as const, agent: 'kimi', model: 'unsupported' }]) {
    const fake = fakeOrca()
    const backend = new OrcaBackend(store, '/tmp', { executors: { codex: executor } }, fake.runner)
    await assert.rejects(backend.preflightScenario(parseScenario(source)), /local|unsupported/)
    assert.equal(fake.calls.filter(args => args[1] === 'run-create').length, 0)
  }
  const fake = fakeOrca()
  const runner: CommandRunner = (file, args, ...rest) => args[0] === 'status' ? Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { state: 'ready', capabilities: [] } } }), stderr: '' }) : fake.runner(file, args, ...rest)
  const backend = new OrcaBackend(store, '/tmp', { executors: { codex: { kind: 'codex' } } }, runner)
  await assert.rejects(backend.preflightScenario(parseScenario(source)), /orchestration contract/)
  assert.equal(fake.calls.length, 0)
})

for (const failedReviewTransport of [false, true]) test(`semantic native re-review uses a fresh Task and preserves the ${failedReviewTransport ? 'failed' : 'successful'} worker report`, async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-review-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const tasks = new Map<string, Record<string, unknown>>()
  const dispatches = new Map<string, string>()
  const starts: string[][] = []
  let reviews = 0
  const runner: CommandRunner = async (_file, args) => {
    const flag = (name: string) => args[args.indexOf(name) + 1]
    const command = args.slice(0, 2).join(' ')
    let result: unknown = {}
    if (args[0] === 'status') result = { runtime: { state: 'ready', capabilities: ['orchestration.contract.v1', 'orchestration.worker-stop-verdict.v1'] } }
    if (command === 'worktree show') result = { worktree: { path: args[args.indexOf('--worktree') + 1].replace(/^path:/, ''), address: { environment: 'local', worktree: 'identity:fixture' } } }
    if (command === 'terminal create') result = { terminal: { id: 'owner' } }
    if (command === 'orchestration run-create') result = { run: { id: 'native-review' } }
    if (command === 'orchestration task-create') {
      const id = 'task_' + tasks.size
      tasks.set(id, { id, title: flag('--task-title'), spec: flag('--spec'), status: 'ready' }); result = { task: { id } }
    }
    if (command === 'orchestration worker-start') {
      starts.push(args)
      const task = tasks.get(flag('--task'))!
      const review = String(task.title).startsWith('Evidence Gate')
      const text = review ? JSON.stringify({ pipelineReview: { version: 1, verdict: ++reviews === 1 ? 'FIX-FIRST' : 'SHIP', findings: 'Independent file evidence' }, report: 'Review complete' }) : 'Author or separate repair completed'
      const failed = review && reviews === 1 && failedReviewTransport
      task.status = failed ? 'failed' : 'completed'; task.result = { provenance: 'worker_report', outcome: failed ? 'failed' : 'succeeded', body: text, filesModified: [] }
      const id = 'dispatch_' + dispatches.size; dispatches.set(id, String(task.id)); result = { dispatch: { id } }
    }
    if (command === 'orchestration task-list') result = { tasks: [...tasks.values()] }
    if (command === 'orchestration worker-read') result = { text: (tasks.get(dispatches.get(flag('--dispatch'))!)!.result as { body: string }).body }
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  }
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' }, reviewer: { kind: 'codex' } }, orca: { visibleWorkers: false } }, runner)
  const coordinator = new Coordinator({ client: backend, save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  const run = await coordinator.start({ id: 'folder:' + project, kind: 'folder', name: 'test', path: project, branch: null, hostId: null }, 'owner', parseScenario('version: 2\n' + source.replace('agent: codex', 'agent: codex\n    reviewAgent: reviewer')))
  await settle(coordinator, run)
  assert.equal(run.status, 'done', JSON.stringify(run.tasks))
  const evidence = run.tasks['audit-evidence']
  assert.deepEqual(evidence.attempts.map(attempt => attempt.review?.verdict), ['FIX-FIRST', 'SHIP'])
  assert.equal(evidence.attempts[0].checks?.[0].exitCode, 0)
  assert.notEqual(evidence.attempts[0].taskId, evidence.attempts[1].taskId)
  assert.equal(starts.length, 4); assert.equal(tasks.size, 4)
  assert.ok(!starts[3].includes('--retry-of'))
  const old = tasks.get(evidence.attempts[0].taskId!)!
  assert.equal(old.status, failedReviewTransport ? 'failed' : 'completed'); assert.equal((old.result as { outcome: string }).outcome, failedReviewTransport ? 'failed' : 'succeeded')
  await backend.reconcile(run)
  assert.equal(run.tasks['audit-evidence'].attempts.length, 2)
})

test('Orca adapter uses an exact workspace, its own coordinator and independent acceptance', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-port-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca()
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } }, orca: { visibleWorkers: false } }, fake.runner)
  const coordinator = new Coordinator({ client: backend, save: async run => store.put('run:' + run.id, run), notify: () => {}, log: () => {} })
  const run = await coordinator.start({ id: 'folder:' + project, kind: 'folder', name: 'test', path: project, branch: null, hostId: null }, 'local-supervisor', parseScenario(source))
  await settle(coordinator, run)
  assert.equal(run.status, 'done')
  assert.deepEqual(run.tasks.audit.attempts[0].checks, [{ command: 'pwd', exitCode: 0 }])
  const start = fake.calls.find(args => args[1] === 'worker-start')!
  assert.equal(start[start.indexOf('--from') + 1], 'term_coordinator')
  assert.equal(start[start.indexOf('--worktree') + 1], 'identity:exact-project')
  assert.equal(fake.calls.filter(args => args[0] === 'terminal' && args[1] === 'create').length, 1)
})

test('native Task receipt survives the gap before its port mapping without creating another Task', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-task-gap-')); t.after(() => rm(project, { recursive: true, force: true }))
  let fail = true
  class Store extends RunStore { override put(key: string, value: unknown, ...rest: [string?, unknown?]) { if (key.startsWith('orca-task-intent:') && (value as { id?: string })?.id && fail) { fail = false; throw new Error('injected task mapping crash') } super.put(key, value, ...rest) } }
  const store = new Store(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } }, orca: { visibleWorkers: false } }, fake.runner)
  await backend.preflightScenario(scenario)
  const runId = await backend.createRun('Audit', 'owner')
  await assert.rejects(backend.createTask(runId, 'owner', scenario.steps[0], 'spec', []), /mapping crash/)
  assert.equal(await backend.createTask(runId, 'owner', scenario.steps[0], 'spec', []), 'task_native')
  assert.equal(fake.calls.filter(args => args[1] === 'task-create').length, 1)
})

test('native worker journal restores a missing attempt and port receipt without starting another worker', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-dispatch-gap-')); t.after(() => rm(project, { recursive: true, force: true }))
  let fail = true
  class Store extends RunStore { override put(key: string, value: unknown, ...rest: [string?, unknown?]) { if (key.startsWith('orca-dispatch:') && fail) { fail = false; throw new Error('injected dispatch mapping crash') } super.put(key, value, ...rest) } }
  const store = new Store(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  const config = { executors: { codex: { kind: 'codex' as const } }, orca: { visibleWorkers: false } }
  const backend = new OrcaBackend(store, project, config, fake.runner)
  await backend.preflightScenario(scenario)
  const runId = await backend.createRun('Audit', 'owner')
  const taskId = await backend.createTask(runId, 'owner', scenario.steps[0], 'spec', [])
  const run: PipelineRun = { id: 'core-run', runId, coordinatorHandle: 'owner', workspaceId: project, workspacePath: project, scenario, tasks: { audit: { stepId: 'audit', taskId, agent: 'codex', status: 'ready', attempts: [] } }, status: 'running', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' }
  await assert.rejects(backend.startWorker(run, scenario.steps[0], taskId, 'codex'), /mapping crash/)
  // Also lose the port's dispatch ID; only the underlying native request receipt remains.
  const intent = store.list<any>('orca-start-intent:')[0]
  const keyHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify([runId, taskId, 'codex', null])).digest('hex')
  store.put('orca-start-intent:' + keyHash, { ...intent, dispatchId: undefined })
  const restarted = new OrcaBackend(store, project, config, fake.runner)
  await restarted.reconcile(run)
  assert.equal(run.tasks.audit.attempts.length, 1)
  assert.equal(run.tasks.audit.attempts[0].dispatchId, 'dispatch_native')
  assert.equal(run.tasks.audit.attempts[0].agent, 'codex')
  assert.equal(fake.calls.filter(args => args[1] === 'worker-start').length, 1)
  assert.equal(store.get<any>('orca-dispatch:dispatch_native').taskId, taskId)
  await restarted.reconcile(run)
  assert.equal(run.tasks.audit.attempts.length, 1)
})

test('an unknown native start intent blocks reconciliation and cannot relaunch a terminal or worker', async t => {
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  const backend = new OrcaBackend(store, '/tmp', { executors: { codex: { kind: 'codex' } } }, fake.runner)
  store.put('native-run:r', { backend: 'orca', owner: 'owner', workspace: 'identity:exact-project' })
  store.put('orca-start-intent:unknown', { requestId: 'unknown', runId: 'r', taskId: 't', stepId: 'audit', agent: 'codex', startedAt: '2026-11-13T00:00:00Z' })
  const run: PipelineRun = { id: 'core', runId: 'r', coordinatorHandle: 'owner', workspaceId: '/tmp', workspacePath: '/tmp', scenario, tasks: { audit: { stepId: 'audit', taskId: 't', agent: 'codex', status: 'ready', attempts: [] } }, status: 'running', createdAt: '', updatedAt: '' }
  await assert.rejects(backend.reconcile(run), /unconfirmed/)
  assert.equal(run.tasks.audit.attempts.length, 0)
  assert.equal(fake.calls.some(args => ['worker-start', 'launch', 'task-create'].includes(args[1])), false)
})

test('native skipped tasks use a truthful blocked condition receipt and never invent worker success', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-skip-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } } }, fake.runner)
  await backend.preflightScenario(scenario)
  const runId = await backend.createRun('Audit', 'owner')
  await backend.skipTask(runId, 'owner', 'task_native', 'Condition evaluated to false')
  await backend.skipTask(runId, 'owner', 'task_native', 'Condition evaluated to false')
  const calls = fake.calls.filter(args => args[1] === 'task-update')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][calls[0].indexOf('--status') + 1], 'blocked')
  assert.deepEqual(JSON.parse(calls[0][calls[0].indexOf('--result') + 1]), { provenance: 'pipeline_condition', outcome: 'skipped', reason: 'Condition evaluated to false' })
  assert.equal(fake.calls.some(args => args[1] === 'worker-start'), false)
})

test('known terminal readiness rejection can be explicitly retried without a second dispatch or terminal', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-readiness-retry-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  let menu = true
  const runner: CommandRunner = async (file, args, cwd, timeout) => args[0] === 'terminal' && args[1] === 'show'
    ? { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { terminal: { agentIdentity: 'codex', connected: true, writable: true, agentWait: menu ? { reason: 'agent-update-prompt' } : {} } } }) }
    : fake.runner(file, args, cwd, timeout)
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } }, orca: { visibleWorkers: false } }, runner)
  await backend.preflightScenario(scenario)
  const runId = await backend.createRun('Audit', 'owner')
  const taskId = await backend.createTask(runId, 'owner', scenario.steps[0], 'spec', [])
  const run: PipelineRun = { id: 'core', runId, coordinatorHandle: 'owner', workspaceId: project, workspacePath: project, scenario, tasks: {}, status: 'running', createdAt: '', updatedAt: '' }
  await assert.rejects(backend.startWorker(run, scenario.steps[0], taskId, 'codex', 'previous-failed', 'term-reused'), error => (error as Error & { startOutcome?: string }).startOutcome === 'rejected')
  assert.equal(fake.calls.filter(args => args[1] === 'worker-start').length, 0)
  menu = false
  assert.equal(await backend.startWorker(run, scenario.steps[0], taskId, 'codex', 'previous-failed', 'term-reused'), 'dispatch_native')
  assert.equal(fake.calls.filter(args => args[1] === 'worker-start').length, 1)
  await assert.rejects(backend.startWorker(run, scenario.steps[0], taskId, 'codex', 'previous-failed', 'term-reused'), /already has a durable intent/)
  assert.equal(fake.calls.filter(args => args[1] === 'worker-start').length, 1)
})

test('native readiness failure consumes no attempt and its explicit successor restores as the only active attempt', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-readiness-gap-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca(), scenario = parseScenario(source)
  let starts = 0
  const runner: CommandRunner = async (file, args, cwd, timeout) => {
    if (args[1] === 'worker-start') return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'd' + ++starts } } }) }
    if (args[1] === 'worker-show') {
      const id = args[args.indexOf('--dispatch') + 1]
      return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { dispatch: { id, taskId: 'task_native', runId: 'run_native' }, worker: id === 'd1' ? { state: 'failed', stage: 'agent_readiness', agentTerminalHandle: 'term_worker', effects: [] } : { state: 'working', effects: [{ kind: 'dispatch_input', state: 'accepted' }] } } }) }
    }
    return fake.runner(file, args, cwd, timeout)
  }
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } }, orca: { visibleWorkers: false } }, runner)
  await backend.preflightScenario(scenario)
  const runId = await backend.createRun('Audit', 'owner')
  const taskId = await backend.createTask(runId, 'owner', scenario.steps[0], 'spec', [])
  const run: PipelineRun = { id: 'core-run', runId, coordinatorHandle: 'owner', workspaceId: project, workspacePath: project, scenario, tasks: { audit: { stepId: 'audit', taskId, agent: 'codex', status: 'ready', attempts: [] } }, status: 'running', createdAt: '', updatedAt: '' }
  assert.equal(await backend.startWorker(run, scenario.steps[0], taskId, 'codex'), 'd1')
  await backend.reconcile(run)
  assert.equal(run.tasks.audit.attempts.length, 0)
  assert.equal(run.tasks.audit.startup?.dispatchId, 'd1')
  assert.equal(run.tasks.audit.startup?.terminalHandle, 'term_worker')
  assert.equal(run.status, 'failed')
  run.status = 'running'
  assert.equal(await backend.startWorker(run, scenario.steps[0], taskId, 'codex', 'd1'), 'd2')
  await backend.reconcile(run)
  assert.equal(run.tasks.audit.attempts.length, 1)
  assert.equal(run.tasks.audit.attempts[0].dispatchId, 'd2')
  assert.equal(run.tasks.audit.startup, undefined)
  assert.equal(run.status, 'running')
  assert.equal(starts, 2)
})

test('unconfirmed native coordinator creation is never repeated automatically', async t => {
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca()
  const backend = new OrcaBackend(store, process.cwd(), { executors: { codex: { kind: 'codex' } } }, fake.runner)
  await backend.preflightScenario(parseScenario(source)); backend.creationRequestId = 'same-request'
  store.put('orca-owner:same-request', { stage: 'intent' })
  await assert.rejects(backend.createRun('Audit', 'owner'), /unconfirmed/)
  assert.equal(fake.calls.filter(args => args[0] === 'terminal' && args[1] === 'create').length, 0)
})

test('an ambient Orca agent uses its own caller identity and never impersonates a terminal', async t => {
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca()
  const backend = new OrcaBackend(store, process.cwd(), { executors: { codex: { kind: 'codex' } } }, fake.runner, 'agent_self')
  await backend.preflightScenario(parseScenario(source))
  const id = await backend.createRun('Audit', 'local-supervisor')
  await backend.createTask(id, 'ignored', parseScenario(source).steps[0], 'Read', [])
  assert.equal(fake.calls.filter(args => args[0] === 'terminal' && args[1] === 'create').length, 0)
  assert.ok(fake.calls.filter(args => args[0] === 'orchestration').every(args => !args.includes('--from')))
})

test('native preflight rejects a configured workspace belonging to another project before any resource creation', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-project-')); t.after(() => rm(project, { recursive: true, force: true }))
  const store = new RunStore(':memory:'); t.after(() => store.close())
  const fake = fakeOrca()
  const backend = new OrcaBackend(store, project, { executors: { codex: { kind: 'codex' } }, orca: { workspace: 'path:/tmp' } }, fake.runner)
  await assert.rejects(backend.preflightScenario(parseScenario(source)), /does not match/)
  assert.equal(fake.calls.some(args => ['run-create', 'task-create', 'launch', 'create'].includes(args[1])), false)
})
