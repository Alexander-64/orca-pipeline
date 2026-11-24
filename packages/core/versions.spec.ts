import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Coordinator, assertRunVersions } from './coordinator'
import { parseScenario } from './scenario'
import type { PipelineRun } from './types'
import type { ExecutionBackend } from './contracts'
const legacy = (): PipelineRun => ({ id: 'legacy', runId: 'native', coordinatorHandle: 'owner', workspaceId: 'folder:/tmp', workspacePath: '/tmp', scenario: parseScenario('name: old\nobjective: Test\nsteps:\n - {id: a, title: A, agent: pi, spec: Read, acceptance: [pwd]}\n'), tasks: {}, status: 'paused', createdAt: '', updatedAt: '' })

test('legacy plugin snapshots and current run formats read without rewriting the input', () => {
  const old = legacy(), current = { ...legacy(), id: 'current', stateVersion: 2 }
  const before = JSON.stringify([old, current])
  let writes = 0
  const coordinator = new Coordinator({ client: {} as ExecutionBackend, save: async () => { writes++ }, notify: () => {}, log: () => {} })
  coordinator.restore([old, current])
  assert.equal(coordinator.list().length, 2)
  assert.equal(JSON.stringify([old, current]), before)
  assert.equal(writes, 0)
})

test('future state or scenario versions reject the whole restore before binding any native run', () => {
  let binds = 0
  const client = { bindRun: async () => { binds++ } } as unknown as ExecutionBackend
  const coordinator = new Coordinator({ client, save: async () => {}, notify: () => {}, log: () => {} })
  const active = { ...legacy(), status: 'running' as const }
  const future = { ...legacy(), id: 'future', stateVersion: 5 }
  const before = JSON.stringify([active, future])
  assert.throws(() => coordinator.restore([active, future]), /Unsupported saved pipeline state/)
  assert.equal(binds, 0); assert.equal(coordinator.list().length, 0)
  assert.equal(JSON.stringify([active, future]), before)
  assert.throws(() => assertRunVersions([{ ...legacy(), scenario: { ...legacy().scenario, version: 3 } } as unknown as PipelineRun]), /Unsupported saved scenario/)
})
