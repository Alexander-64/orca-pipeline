import { assert, test } from 'orca/testing'
import { extractText, OrcaClient, workspaceSelector, type CommandResult } from './cli'
import { parseScenario } from './scenario'

const scenario = parseScenario(`name: test
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
    placement: { host: server, worktree: new-top-level, repo: id:repo }
`)

test('builds explicit remote retry arguments without a shell', async () => {
  const calls: { file: string; args: string[] }[] = []
  const runner = async (file: string, args: string[]): Promise<CommandResult> => {
    calls.push({ file, args })
    const result = args.includes('status')
      ? { runtime: { state: 'ready', capabilities: [] } }
      : args.includes('show') ? {} : { dispatch: { id: 'ctx_2' } }
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  }
  const client = new OrcaClient(runner, 'orca-test')
  const id = await client.startWorker(
    { runId: 'run_1', coordinatorHandle: 'term_1', workspacePath: '/work' },
    scenario.steps[0],
    'task_1',
    'claude',
    'ctx_1'
  )
  assert.equal(id, 'ctx_2')
  const start = calls.at(-1)!
  const staticArgs = start.args.filter((arg, index) => arg !== '--retry-request' && start.args[index - 1] !== '--retry-request')
  assert.ok(start.args.includes('--retry-request'))
  assert.deepEqual(staticArgs, [
    'orchestration', 'worker-start', '--run', 'run_1', '--from', 'term_1',
    '--task', 'task_1', '--agent', 'claude', '--worktree', 'new-top-level',
    '--on', 'server', '--repo', 'id:repo', '--retry-of', 'ctx_1', '--json', '--full'
  ])
})

test('surfaces structured Orca errors', async () => {
  const client = new OrcaClient(async () => ({
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { message: 'task_not_startable' } }),
    stderr: ''
  }))
  await assert.rejects(() => client.listTasks('run_1'), /task_not_startable/)
})

test('uses exact workspace selectors instead of ambiguous paths', () => {
  assert.equal(workspaceSelector({ id: 'repo::/same/path', kind: 'folder' }), 'id:repo::/same/path')
  assert.equal(workspaceSelector({ id: 'repo::/same/path', kind: 'worktree' }), 'id:repo::/same/path')
  assert.equal(workspaceSelector({ id: 'identity:wt2:local:1', kind: 'worktree' }), 'identity:wt2:local:1')
})

test('reads nested transcript and archived terminal output', () => {
  assert.equal(extractText({ transcript: { messages: [{ blocks: [{ text: 'usageLimitReached' }] }] } }), 'usageLimitReached')
  assert.equal(extractText({ terminal: { tail: ['pwd', '/work', 'worker_done'] } }), 'pwd\n/work\nworker_done')
})
