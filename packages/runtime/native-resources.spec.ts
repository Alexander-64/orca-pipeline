import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrcaClient, type CommandRunner } from '../../src/cli'
import { MemoryMutationJournal } from '../core/mutations'
import { parseScenario } from '../core/scenario'
import type { PipelineRun } from '../core/types'

const scenario = () => parseScenario('name: resource-test\nobjective: Test\nsteps:\n - {id: audit, title: Audit, agent: codex, spec: Read, acceptance: [pwd]}\n')
const run = { runId: 'run', coordinatorHandle: 'owner', workspacePath: '/project', workspaceSelector: 'path:/project', visibleWorkers: true }
function fixture(options: { unknownStart?: boolean; failedReadiness?: boolean; lostLaunch?: boolean; lostClose?: boolean } = {}) {
  const journal = new MemoryMutationJournal(), calls: string[][] = []
  let incarnation = 'created-generation', state = 'working'
  const fail = (message: string, result = {}) => ({ code: 1, stderr: '', stdout: JSON.stringify({ ok: false, error: { message }, result }) })
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args)
    if (args.includes('--retry-request')) assert.match(args[args.indexOf('--retry-request') + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    const command = args.slice(0, 2).join(' ')
    let result: unknown = {}
    if (command === 'agent launch') {
      if (options.lostLaunch) return fail('Launch reply lost after creating the terminal')
      result = { outcome: { kind: 'terminal', handle: 'owned-terminal' } }
    }
    if (command === 'terminal show') result = { terminal: { handle: args[args.indexOf('--terminal') + 1], incarnationId: incarnation, worktreeId: 'project', worktreePath: '/project', connected: true, writable: true, agentIdentity: 'codex' } }
    if (command === 'orchestration worker-start') {
      if (options.unknownStart || options.failedReadiness) {
        state = options.unknownStart ? 'start_unknown' : 'failed'
        return fail('Task input was written but turn start was not observed', { runId: 'run', taskId: 'task', dispatchId: 'dispatch', state, failedStage: options.failedReadiness ? 'agent_readiness' : 'turn_start_unobserved' })
      }
      result = { dispatch: { id: 'dispatch' } }
    }
    if (command === 'orchestration worker-stop') {
      if (state === 'abandoned') result = { state: 'abandoned' }
      else { state = 'stop_unknown'; return fail('The worker terminal is external; no terminal was closed.', { state }) }
    }
    if (command === 'orchestration worker-show') result = { dispatch: { id: 'dispatch', runId: 'run', taskId: 'task' }, worker: { state, agentTerminalHandle: 'owned-terminal', effects: [{ kind: 'dispatch_input', state: 'accepted' }] } }
    if (command === 'terminal close') {
      if (options.lostClose) return fail('Close acknowledgement lost')
      result = { close: { handle: 'owned-terminal', ptyKilled: true } }
    }
    if (command === 'orchestration worker-abandon') { state = 'abandoned'; result = { state } }
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result }) }
  }
  const client = () => new OrcaClient(runner, 'fixture-orca', journal)
  return { client, calls, journal, changeGeneration: () => { incarnation = 'repurposed-generation' } }
}

test('pipeline-owned visible terminal cancellation verifies generation, persists PTY death and fences the Dispatch', async () => {
  const f = fixture(), client = f.client()
  await client.startWorker(run, scenario().steps[0], 'task', 'codex')
  await client.stopWorker('dispatch'); await f.client().stopWorker('dispatch')
  assert.equal(f.calls.filter(args => args[0] === 'terminal' && args[1] === 'close').length, 1)
  assert.equal(f.calls.filter(args => args[1] === 'worker-abandon').length, 1)
  const receipt = (await f.journal.list()).find(entry => entry.args[0] === 'terminal' && entry.args[1] === 'close')!
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.result?.processStopped, true)
})

test('an externally supplied terminal is never closed by the pipeline without a creation receipt', async () => {
  const f = fixture(), client = f.client()
  await client.startWorker(run, scenario().steps[0], 'task', 'codex', undefined, 'owned-terminal')
  await assert.rejects(client.stopWorker('dispatch'), /terminal is external/)
  assert.equal(f.calls.some(args => args[0] === 'terminal' && args[1] === 'close'), false)
})

test('a repurposed PTY generation cannot be cancelled using an old terminal ownership receipt', async () => {
  const f = fixture(), client = f.client()
  await client.startWorker(run, scenario().steps[0], 'task', 'codex')
  f.changeGeneration()
  await assert.rejects(client.stopWorker('dispatch'), /identity changed/)
  assert.equal(f.calls.some(args => args[0] === 'terminal' && args[1] === 'close'), false)
})

test('a structured start_unknown receipt pauses retries and can reconcile its exact accepted Dispatch', async () => {
  const f = fixture({ unknownStart: true }), client = f.client(), plan = scenario()
  await assert.rejects(client.startWorker(run, plan.steps[0], 'task', 'codex'), error => (error as { startOutcome?: string }).startOutcome === 'unknown')
  const saved: PipelineRun = { ...run, id: 'core', workspaceId: '/project', scenario: plan, status: 'paused', tasks: { audit: { stepId: 'audit', taskId: 'task', agent: 'codex', status: 'blocked', unconfirmedStart: true, attempts: [] } }, createdAt: '', updatedAt: '' }
  await f.client().reconcile(saved)
  assert.equal(saved.tasks.audit.attempts[0].dispatchId, 'dispatch')
  assert.equal(saved.tasks.audit.unconfirmedStart, undefined)
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1)
})

test('a positively failed native readiness receipt remains an explicit startup failure', async () => {
  const f = fixture({ failedReadiness: true })
  await assert.rejects(f.client().startWorker(run, scenario().steps[0], 'task', 'codex'), error => (error as { startOutcome?: string }).startOutcome !== 'unknown')
})

test('a lost visible launch receipt is never replaced by a second fresh launch', async () => {
  const f = fixture({ lostLaunch: true })
  await assert.rejects(f.client().startWorker(run, scenario().steps[0], 'task', 'codex'), /reply lost/)
  await assert.rejects(f.client().startWorker(run, scenario().steps[0], 'task', 'codex'), /unconfirmed/)
  await assert.rejects(f.client().recoverPending(), /unconfirmed receipt/)
  assert.equal(f.calls.filter(args => args[0] === 'agent').length, 1)
  assert.equal(f.calls.some(args => args[1] === 'worker-start'), false)
})

test('a lost PTY-close receipt cannot be turned into confirmed cancellation or blindly repeated', async () => {
  const f = fixture({ lostClose: true }), client = f.client()
  await client.startWorker(run, scenario().steps[0], 'task', 'codex')
  await assert.rejects(client.stopWorker('dispatch'), /acknowledgement lost/)
  await assert.rejects(f.client().stopWorker('dispatch'), /close outcome is unconfirmed/)
  assert.equal(f.calls.filter(args => args[0] === 'terminal' && args[1] === 'close').length, 1)
  assert.equal(f.calls.some(args => args[1] === 'worker-abandon'), false)
})
