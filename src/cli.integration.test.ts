import { assert, test } from 'orca/testing'
import { OrcaClient, type CommandResult } from './cli'
import { parseScenario } from './scenario'
import { taskSpec, checkpointFile } from './scenario'
import { MemoryMutationJournal } from './mutations'
import type { PipelineRun } from './types'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native reconciliation restores an accepted pending start without issuing another start', async () => {
  const scenario = parseScenario('name: recover\nobjective: Recover\nsteps:\n - {id: audit, title: Audit, spec: Read, agent: codex, acceptance: [pwd]}')
  const journal = new MemoryMutationJournal()
  await journal.put({ requestId: 'request-start', args: ['orchestration', 'worker-start', '--run', 'run', '--task', 'task'], status: 'completed', result: { dispatch: { id: 'dispatch' } } })
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'dispatch', taskId: 'task', runId: 'run', retryOfDispatchId: null }, worker: { state: 'working', effects: [{ kind: 'dispatch_input', state: 'accepted' }] } } }) }
  }, 'orca', journal)
  const run: PipelineRun = { id: 'core', runId: 'run', coordinatorHandle: 'owner', workspaceId: '/tmp', workspacePath: '/tmp', scenario, tasks: { audit: { stepId: 'audit', taskId: 'task', agent: 'codex', status: 'blocked', unconfirmedStart: true, attempts: [] } }, status: 'paused', createdAt: '', updatedAt: '' }
  await client.reconcile(run)
  assert.equal(run.tasks.audit.unconfirmedStart, undefined)
  assert.equal(run.tasks.audit.attempts.length, 1)
  assert.equal(run.tasks.audit.attempts[0].dispatchId, 'dispatch')
  assert.equal(calls.some(args => args[1] === 'worker-start'), false)
})

test('native continuation is written before launch and does not send mail to a potentially settled worker', async () => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-native-checkpoint-'))
  try {
    const scenario = parseScenario('name: checkpoint\nobjective: Recover\nsteps:\n - {id: audit, title: Audit, spec: Read, agent: codex, acceptance: [pwd]}')
    const step = scenario.steps[0]
    const run: PipelineRun = { id: 'core', runId: 'run', coordinatorHandle: 'owner', workspaceId: project, workspacePath: project, scenario, tasks: {}, status: 'running', createdAt: '', updatedAt: '' }
    let legacy = false
    const calls: string[][] = []
    const client = new OrcaClient(async (_file, args) => {
      calls.push(args)
      return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { tasks: [{ id: 'task', spec: legacy ? 'Old immutable Task' : taskSpec(step, undefined, 'run', false) }] } }) }
    }, 'orca')
    await client.prepareCheckpoint(run, step, 'task', 'Verified old report; do not repeat completed work. Bearer synthetic-private-checkpoint')
    const saved = JSON.parse(await readFile(join(project, checkpointFile('run', 'audit')), 'utf8'))
    assert.match(saved.body, /Verified old report/)
    assert.ok(!saved.body.includes('synthetic-private-checkpoint'))
    assert.equal(calls.some(args => args[1] === 'send' || args[1] === 'worker-start'), false)
    legacy = true
    await assert.rejects(() => client.prepareCheckpoint(run, step, 'task', 'Next context'), /predates durable file checkpoints/)
    assert.equal(JSON.parse(await readFile(join(project, checkpointFile('run', 'audit')), 'utf8')).body, saved.body)
  } finally { await rm(project, { recursive: true, force: true }) }
})

test('local worker start uses exact workspace and forwards model and effort', async () => {
  const step = parseScenario(`name: cli
objective: cli
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    model: gpt-test
    effort: high
    acceptance: [test]
`).steps[0]
  let args: string[] = []
  const runner = async (_file: string, argv: string[]): Promise<CommandResult> => {
    args = argv
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'ctx_1' } } }), stderr: '' }
  }
  const client = new OrcaClient(runner, 'orca')
  await client.startWorker(
    { runId: 'run_1', coordinatorHandle: 'term_1', workspacePath: '/work', workspaceSelector: 'id:repo::/work' },
    step,
    'task_1',
    'codex'
  )
  assert.ok(args.includes('--worktree'))
  assert.equal(args[args.indexOf('--worktree') + 1], 'id:repo::/work')
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-test')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
})

test('worker activity requires positive done or exited evidence', async () => {
  const responses = [
    { projection: { stage: { activity: 'done' } }, observation: { status: 'live' } },
    { projection: { stage: { activity: 'working' } }, observation: { status: 'live' } },
    { projection: { stage: { activity: 'unknown' } }, observation: { status: 'exited' } }
  ]
  const client = new OrcaClient(async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result: responses.shift() }),
    stderr: ''
  }))
  assert.equal(await client.workerActivityDone('ctx_1'), true)
  assert.equal(await client.workerActivityDone('ctx_1'), false)
  assert.equal(await client.workerActivityDone('ctx_1'), true)
})

test('visible workers wait for agent readiness, launch once and adopt the terminal without a second agent', async () => {
  const step = parseScenario(`name: visible
objective: visible
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    model: test-model
    effort: high
    acceptance: [test]
`).steps[0]
  const calls: string[][] = []
  let showCount = 0
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    const result = args[0] === 'agent' ? { outcome: { kind: 'terminal', handle: 'term_visible' } }
      : args[0] === 'terminal' && args[1] === 'show' ? { terminal: { handle: 'term_visible', incarnationId: 'incarnation', worktreeId: 'workspace', worktreePath: '/work', ...(++showCount > 1 ? { agentIdentity: 'codex', connected: true, writable: true } : {}) } }
      : args.includes('worker-show') ? { worker: { agentTerminalHandle: 'term_visible' } }
      : { dispatch: { id: 'ctx_visible' } }
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  }, 'orca-test')
  const id = await client.startWorker({ runId: 'run', coordinatorHandle: 'coordinator', workspacePath: '/work', workspaceSelector: 'id:repo::/work', visibleWorkers: true, focusWorker: true }, step, 'task', 'codex')
  assert.equal(id, 'ctx_visible')
  const launch = calls.find(args => args[0] === 'agent')!
  assert.equal(launch[launch.indexOf('--surface') + 1], 'terminal')
  assert.ok(launch.includes('--focus'))
  assert.equal(launch[launch.indexOf('--model') + 1], 'test-model')
  const start = calls.find(args => args.includes('worker-start'))!
  assert.equal(start[start.indexOf('--terminal') + 1], 'term_visible')
  assert.equal(start.includes('--agent'), false)
  assert.equal(start.includes('--model'), false)
  assert.ok(start.includes('--keep-open'))
  assert.equal(showCount, 2)
  const wait = calls.find(args => args[0] === 'terminal' && args[1] === 'wait')!
  assert.equal(wait[wait.indexOf('--for') + 1], 'tui-idle')
  assert.ok(calls.indexOf(wait) < calls.indexOf(start))
  await client.openWorker(id)
  assert.ok(calls.some(args => args[0] === 'terminal' && args[1] === 'switch' && args.includes('term_visible')))
})

test('pipeline workspace branches from the selected commit with explicit parent and repository', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    const result = args.includes('show') ? { worktree: { repoId: 'selected-repo', head: 'selected-commit' } }
      : { worktree: { id: 'new-workspace', path: '/new', displayName: 'Pipeline' } }
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  }, 'orca-test')
  const workspace = await client.createPipelineWorkspace({ id: 'identity:selected', path: '/selected', kind: 'worktree', name: 'Selected', hostId: null, branch: 'feature' }, 'demo')
  assert.equal(workspace.id, 'new-workspace')
  const args = calls[1]
  assert.equal(args[args.indexOf('--repo') + 1], 'id:selected-repo')
  assert.equal(args[args.indexOf('--parent-worktree') + 1], 'identity:selected')
  assert.equal(args[args.indexOf('--base-branch') + 1], 'selected-commit')
})

test('legacy background workers give an explicit explanation instead of switching to the wrong tab', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { worker: { agentTerminalHandle: 'structworker_background' } } }), stderr: '' }
  }, 'orca-test')
  await assert.rejects(() => client.openWorker('ctx_old'), /фоновым агентом/)
  assert.equal(calls.length, 1)
})

test('non-orchestration CLI verbs never receive the orchestration-only full flag', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }
  }, 'orca-test')
  for (const args of [['project', 'list'], ['repo', 'list'], ['agent', 'launch'], ['terminal', 'switch']]) await client.call(args)
  for (const args of calls) assert.equal(args.includes('--full'), false)
})

test('startup recovery refuses to reuse a terminal whose agent identity changed', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { agentIdentity: 'other', connected: true, writable: true } } }), stderr: '' }
  }, 'orca-test')
  const step = parseScenario('name: recovery\nobjective: recovery\nsteps:\n  - id: one\n    title: One\n    spec: One\n    agent: codex\n    acceptance: [pwd]\n').steps[0]
  await assert.rejects(() => client.startWorker({ runId: 'run', coordinatorHandle: 'coord', workspacePath: '/work', visibleWorkers: true }, step, 'task', 'codex', 'ctx_failed', 'term_old'), /изменилось/)
  assert.equal(calls.some(args => args.includes('worker-start')), false)
})

test('native questions are read without consuming mail and answers are scoped and idempotent', async () => {
  const calls: string[][] = []
  let replies = 0
  const messages: Record<string, unknown>[] = [
    { id: 'q1', type: 'question', run_id: 'run', body: 'Need predecessor context', created_at: '', payload: JSON.stringify({ dispatchId: 'd1' }) },
    { id: 'foreign', type: 'question', run_id: 'run', body: 'Other worker', payload: { dispatchId: 'd2' } }
  ]
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    if (args[1] === 'reply') { replies++; messages.push({ id: 'r1', type: 'status', thread_id: 'q1', from_handle: 'run:run', to_handle: 'dispatch:d1' }) }
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: args[1] === 'inbox' ? { messages } : {} }) }
  }, 'orca')
  const scenario = parseScenario('name: question\nobjective: question\nsteps:\n - {id: a, title: A, spec: A, agent: codex, acceptance: [pwd]}')
  const run: PipelineRun = { id: 'core', runId: 'run', coordinatorHandle: 'owner', workspaceId: '/work', workspacePath: '/work', scenario, tasks: { a: { stepId: 'a', taskId: 'task', agent: 'codex', status: 'blocked', attempts: [{ dispatchId: 'd1', agent: 'codex', status: 'running', startedAt: '' }] } }, status: 'failed', createdAt: '', updatedAt: '' }
  assert.deepEqual((await client.workerQuestions('d1', 'run')).map(q => q.id), ['q1'])
  await assert.rejects(() => client.answerQuestion(run, 'a', { id: 'm0', questionId: 'foreign', text: 'No' }), /не принадлежит/)
  const answer = { id: 'm1', questionId: 'q1', text: 'Use /pipeline/context; preserve $VALUE' }
  assert.equal((await client.answerQuestion(run, 'a', answer)).state, 'delivered')
  await client.answerQuestion(run, 'a', answer)
  assert.equal(replies, 1)
  assert.equal((await client.workerQuestions('d1', 'run'))[0].state, 'answered')
  assert.equal(calls.some(args => args[1] === 'check' || args[1] === 'gate-resolve' || args[1] === 'worker-start'), false)
  const reply = calls.find(args => args[1] === 'reply')!
  assert.equal(reply[reply.indexOf('--from') + 1], 'owner')
  assert.equal(reply[reply.indexOf('--body') + 1], answer.text)
})
