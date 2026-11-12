import { assert, test } from 'orca/testing'
import { OrcaClient, type CommandResult } from './cli'
import { parseScenario } from './scenario'

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
