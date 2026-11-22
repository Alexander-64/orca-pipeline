import { assert, test } from 'orca/testing'
import { OrcaClient } from './cli'
import { parseScenario } from './scenario'

function remoteStep(extra = '') {
  return parseScenario(`name: remote
objective: remote
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    placement: { host: remote, worktree: new-top-level, repo: id:repo }
    acceptance: [test]
${extra}
`).steps[0]
}

test('checks environment readiness and repository before a remote start', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    const result = args.includes('status') ? { runtime: { state: 'ready', capabilities: [] } } : {}
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  })
  await client.preflight(remoteStep())
  assert.ok(calls[0].includes('--environment'))
  assert.ok(calls.some((args) => args.includes('repo') && args.includes('id:repo')))
})

test('rejects an unavailable environment before any launch', async () => {
  const client = new OrcaClient(async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result: { runtime: { state: 'unreachable', capabilities: [] } } }),
    stderr: ''
  }))
  await assert.rejects(() => client.preflight(remoteStep()), /is not ready/)
})

test('rejects model overrides when the remote lacks launch preferences', async () => {
  const client = new OrcaClient(async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result: { runtime: { state: 'ready', capabilities: [] } } }),
    stderr: ''
  }))
  await assert.rejects(() => client.preflight(remoteStep('    model: gpt-test\n')), /model or effort/)
})

test('checks an exact remote workspace instead of substituting a local path', async () => {
  const calls: string[][] = []
  const client = new OrcaClient(async (_file, args) => {
    calls.push(args)
    const result = args.includes('status') ? { runtime: { state: 'ready', capabilities: [] } } : {}
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  })
  await client.preflight(remoteStep().placement.worktree === 'new-top-level'
    ? parseScenario(`name: remote
objective: remote
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    placement: { host: remote, worktree: id:repo::exact }
    acceptance: [test]
`).steps[0]
    : remoteStep())
  assert.ok(calls.some((args) => args.includes('worktree') && args.includes('id:repo::exact')))
})

test('local preflight performs no runtime calls', async () => {
  let calls = 0
  const client = new OrcaClient(async () => {
    calls += 1
    throw new Error('unexpected call')
  })
  await client.preflight(parseScenario(`name: local
objective: local
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`).steps[0])
  assert.equal(calls, 0)
})
