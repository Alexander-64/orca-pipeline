import { assert, test } from 'orca/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TerminalRunBridge } from './terminal-bridge'
import { RunStore } from '../packages/runtime/store'
import { parseScenario } from './scenario'
import type { PipelineRun, Workspace } from './types'

const scenario = parseScenario('name: bridged\nobjective: Audit\nsteps:\n  - id: audit\n    title: Audit\n    spec: Read source\n    agent: pi\n    acceptance: [pwd]\n')

test('terminal bridge maps only the selected local project and routes controls to its existing owner', async () => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-bridge-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const workspace: Workspace = { id: 'native-project-id', kind: 'worktree', path: project, name: 'Project', branch: 'main', hostId: null }
  const run: PipelineRun = { id: 'console-run', runId: 'local-run', coordinatorHandle: 'supervisor', workspaceId: 'folder:' + project, workspacePath: project, scenario, tasks: {}, status: 'paused', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' }
  store.put('run:' + run.id, run); store.put('native-run:' + run.runId, { backend: 'local' })
  const calls: { project: string; command: string; runId?: string }[] = []
  const bridge = new TerminalRunBridge(async (path, request) => {
    calls.push({ project: path, command: request.command, runId: request.runId })
    if (request.command === 'send') {
      assert.equal(request.messageId, 'stable-message-id'); assert.equal(request.text, 'keep $VALUE; quotes'); assert.equal(request.questionId, 'waiting-question')
      return { run: { ...run, status: 'running' }, receipt: { id: request.messageId, state: 'queued', at: '2026-11-13T00:00:01Z' } }
    }
    return { ...run, status: 'running' }
  })
  try {
    const discovered = await bridge.discover(workspace)
    assert.equal(discovered.length, 1)
    assert.equal(discovered[0].workspaceId, workspace.id)
    assert.equal(discovered[0].controller, 'terminal')
    assert.equal(discovered[0].backend, 'local')
    assert.equal((await bridge.discover({ ...workspace, hostId: 'remote-host' })).length, 0)
    const changed = await bridge.control(run.id, 'resume')
    assert.equal(changed.status, 'running')
    assert.deepEqual(calls, [{ project, command: 'resume', runId: run.id }])
    await assert.rejects(bridge.control('foreign-run', 'stop'), /не найден/)
    assert.equal(calls.length, 1)
    const sent = await bridge.message(run.id, 'audit', { id: 'stable-message-id', text: 'keep $VALUE; quotes', questionId: 'waiting-question' })
    assert.equal(sent.receipt.state, 'queued'); assert.equal(sent.run.controller, 'terminal'); assert.equal(sent.run.workspaceId, workspace.id)
    assert.equal(calls[1].command, 'send')
    await assert.rejects(bridge.message('foreign-run', 'audit', { id: 'm', text: 'text' }), /не найден/)
    assert.equal(calls.length, 2)
  } finally { store.close(); await rm(project, { recursive: true, force: true }) }
})

test('terminal bridge observes a completed run from disk without starting a supervisor', async () => {
  const project = await mkdtemp(join(tmpdir(), 'pipeline-bridge-history-'))
  const store = new RunStore(join(project, '.agent-pipeline/runtime/state.sqlite'))
  const workspace: Workspace = { id: 'native', kind: 'folder', path: project, name: 'Project', branch: null, hostId: null }
  const run: PipelineRun = { id: 'history', runId: 'run_native', coordinatorHandle: 'owner', workspaceId: 'folder:' + project, workspacePath: project, scenario, tasks: {}, status: 'running', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' }
  const bridge = new TerminalRunBridge(async () => { throw new Error('History must not call IPC') })
  try {
    store.put('run:history', run); store.put('native-run:run_native', { backend: 'orca' })
    await bridge.discover(workspace)
    store.put('run:history', { ...run, status: 'done', updatedAt: '2026-11-13T00:01:00Z' })
    const changed = await bridge.poll()
    assert.equal(changed.length, 1); assert.equal(changed[0].status, 'done'); assert.equal(changed[0].backend, 'orca')
    assert.equal((await bridge.poll()).length, 0)
  } finally { store.close(); await rm(project, { recursive: true, force: true }) }
})

test('cold archive pages include 151 runs with tied timestamps and keep an opened old run live', async () => {
  const path = await mkdtemp(join(tmpdir(), 'pipeline-archive-'))
  const store = new RunStore(join(path, '.agent-pipeline/runtime/state.sqlite'))
  const workspace: Workspace = { id: 'archive', kind: 'folder', path, name: 'Archive', branch: null, hostId: null }
  const base: PipelineRun = { id: '', runId: '', coordinatorHandle: 'owner', workspaceId: 'archive', workspacePath: path,
    scenario: { ...scenario, name: 'Проверка' }, tasks: {}, status: 'done', createdAt: '2026-11-15', updatedAt: '2026-11-15' }
  try {
    for (let i = 0; i < 151; i++) {
      const id = String(i).padStart(3, '0')
      store.put('run:' + id, { ...base, id, runId: id, status: i === 0 ? 'paused' : 'done' })
    }
    const bridge = new TerminalRunBridge()
    assert.equal((await bridge.discover(workspace)).length, 100)
    const ids: string[] = []
    let before: { id: string; createdAt: string } | undefined
    for (;;) {
      const page = await bridge.page(workspace, { before, search: 'ПРОВЕРКА' }, 25)
      ids.push(...page.map(row => row.id))
      if (page.length < 25) break
      before = page[page.length - 1]
    }
    assert.equal(new Set(ids).size, 151); assert.equal(ids.length, 151); assert.equal(ids.at(-1), '000')
    assert.deepEqual((await bridge.page(workspace, { status: 'paused' }, 25)).map(row => row.id), ['000'])
    assert.equal((await bridge.lookup(workspace, '000'))?.status, 'paused')
    store.put('run:000', { ...base, id: '000', runId: '000', status: 'done' })
    assert.deepEqual((await bridge.poll()).map(run => [run.id, run.status]), [['000', 'done']])
  } finally { store.close(); await rm(path, { recursive: true, force: true }) }
})
