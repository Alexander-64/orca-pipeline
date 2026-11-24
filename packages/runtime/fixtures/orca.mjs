#!/usr/bin/env node
// A deterministic native CLI for supervisor contract tests; no Orca connection.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const project = dirname(fileURLToPath(import.meta.url))
const path = join(project, 'fake-orca-state.json')
let state
try { state = JSON.parse(readFileSync(path, 'utf8')) } catch { state = { tasks: [], workers: [], starts: 0 } }
const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1]
const command = args.slice(0, 2).join(' ')
let result = {}, error
if (args[0] === 'status') result = { runtime: { state: 'ready', capabilities: ['orchestration.contract.v1', 'orchestration.worker-launch-preferences.v1', 'orchestration.worker-stop-verdict.v1'] } }
if (command === 'worktree show') result = { worktree: { path: project, address: { environment: 'local', worktree: 'path:' + project } } }
if (command === 'terminal create') result = { terminal: { id: 'fixture-owner' } }
if (command === 'orchestration run-create') result = { run: { id: 'fixture-run' } }
if (command === 'orchestration task-create') {
  const task = { id: 'task_' + state.tasks.length, spec: flag('--spec'), status: 'ready', task_title: flag('--task-title') }
  state.tasks.push(task); result = { task }
}
if (command === 'orchestration worker-start') {
  const task = state.tasks.find(task => task.id === flag('--task'))
  const id = 'dispatch_' + state.starts++, terminal = 'term_fixture_' + id
  const body = 'Native fixture worker report; acceptance is independent'
  task.status = 'completed'; task.result = { provenance: 'worker_report', outcome: 'succeeded', body, filesModified: [], reportedBy: terminal }
  const worker = { dispatchId: id, agentTerminalHandle: terminal, state: 'succeeded', effects: [{ kind: 'dispatch_input', state: 'accepted' }] }
  state.workers.push({ dispatch: { id, taskId: task.id, runId: 'fixture-run' }, worker }); result = { dispatch: { id } }
}
if (command === 'orchestration task-list') result = { tasks: state.tasks }
if (command === 'orchestration worker-show') result = state.workers.find(row => row.dispatch.id === flag('--dispatch'))
if (command === 'orchestration worker-read') result = { text: 'Native fixture worker report; acceptance is independent' }
if (command === 'orchestration worker-stop') error = 'Fixture native worker has already settled; cancel the independent acceptance actor'
if (command === 'orchestration worker-release') result = { released: true }
writeFileSync(path, JSON.stringify(state))
console.log(JSON.stringify({ ok: !error, ...(error ? { error: { message: error } } : { result }) }))
if (error) process.exitCode = 1
