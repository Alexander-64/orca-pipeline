#!/usr/bin/env node
import { bindIsolated, isolatedChanges, prepareIsolated } from './isolation'
import { workspaceRestrictionConflicts } from '../core/scenario'
import { parseArgs } from 'node:util'
import { readFile, realpath, mkdir, open } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { parseScenario } from '../core/scenario'
import { redactSecrets } from '../core/failover'
import type { PipelineRun, MessageReceipt } from '../core/types'
import { loadConfig } from '../runtime/config'
import { createBackend } from '../runtime/factory'
import { RunStore } from '../runtime/store'
import { request, serve, type Request } from '../runtime/supervisor'
import { IncompatibleRuntimeError } from '../core/terminal-ipc'

type Dashboard = { runs: PipelineRun[]; events: { seq: number; kind: string; data: unknown }[] }

export async function ensureSupervisor(project: string): Promise<void> {
  const ping: Request = { id: randomUUID(), command: 'ping' }
  try { await request(project, ping, 1000); return } catch (error) { if (error instanceof IncompatibleRuntimeError) throw error }
  const logPath = join(project, '.agent-pipeline', 'runtime', 'supervisor.log')
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  const log = await open(logPath, 'a', 0o600)
  const entry = fileURLToPath(import.meta.url)
  const args = [...(entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), entry, 'serve', '--project', project]
  const child = spawn(process.execPath, args, { cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd] })
  let error: Error | undefined
  child.once('error', value => { error = value }); child.unref()
  await log.close()
  for (let i = 0; i < 100; i++) {
    if (error) throw error
    try { await request(project, ping, 500); return } catch (error) { if (error instanceof IncompatibleRuntimeError) throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Supervisor did not become ready. See .agent-pipeline/runtime/supervisor.log')
}

function summary(run: PipelineRun): string {
  return [
    `${run.scenario.name} · ${run.status} · завершено ${Object.values(run.tasks).filter(task => ['done', 'skipped', 'failed', 'superseded'].includes(task.status)).length}/${run.scenario.steps.length} · пропущено ${Object.values(run.tasks).filter(task => task.status === 'skipped').length}`,
    `Run: ${run.id}`,
    ...run.scenario.steps.map(step => {
      const task = run.tasks[step.id]
      return [`${task?.status === 'done' ? '✓' : task?.status === 'running' ? '▶' : '·'} ${step.id}: ${step.title} · ${task?.agent ?? step.agent} · ${task?.status ?? 'pending'}${task?.error ? ' · ' + task.error : ''}${task?.gateId && task.status === 'blocked' ? ' · awaiting approval' : ''}`,
        ...(task?.questions?.filter(question => question.state === 'waiting').map(question => `  Question ${question.id}: ${question.question}`) ?? []),
        ...(task?.skipReason ? ['  Пропуск: ' + task.skipReason] : []),
        ...(task?.data ? ['  Data: ' + JSON.stringify(task.data)] : []),
        ...(task?.messages?.slice(-4).map(message => `  Message ${message.id}: ${message.state}`) ?? [])].join('\n')
    }),
    ...(run.error ? ['Error: ' + run.error] : [])
  ].join('\n')
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string', short: 'C' }, file: { type: 'string', short: 'f' }, json: { type: 'boolean' },
    watch: { type: 'boolean' }, run: { type: 'string' }, step: { type: 'string' }, agent: { type: 'string' },
    'request-id': { type: 'string' }, reject: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, backend: { type: 'string' },
    isolated: { type: 'string' }, digest: { type: 'string' }, text: { type: 'string' }, question: { type: 'string' }, 'message-id': { type: 'string' }
  } })
  const command = positionals[0] ?? (process.stdin.isTTY && process.stdout.isTTY ? 'ui' : 'help')
  if (values.version) { const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')); console.log(values.json ? JSON.stringify({ version }) : version); return }
  let project = await realpath(values.project ?? process.cwd())
  const originalProject = project
  const output = (value: unknown) => console.log(values.json ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  if (values.help || command === 'help') {
    output('Agent Pipeline\n\n  pipeline ui [-C project] [--backend local|orca]\n  pipeline projects [--backend orca]\n  pipeline agent "request" [-f plan.pipeline.yaml] [--run id]\n  pipeline plan "task" [-C project] [-f plan.pipeline.yaml]\n  pipeline validate -f plan.pipeline.yaml\n  pipeline run -f plan.pipeline.yaml [--watch] [--json] [--isolated new-directory]\n  pipeline diff|accept -C source --isolated directory --run id [--digest reviewed-sha256]\n  pipeline status | attach [--run id] [--json]\n  pipeline pause|resume|stop|retry --run id\n  pipeline approve --run id --step id [--reject]\n  pipeline assign --run id --step id --agent executor\n  pipeline send --run id --step id --text message [--message-id id]\n  pipeline answer --run id --step id --question id --text answer\n  pipeline recover --run id --step id\n  pipeline reconcile --run id\n  pipeline doctor\n\nExisting agent credentials are used. YAML and state are saved under .agent-pipeline/.')
    return
  }
  if (command === 'serve') { await serve(project); return }
  const config = await loadConfig(project)
  if (values.backend !== undefined && !['local', 'orca'].includes(values.backend)) throw new Error('--backend must be local or orca')
  if (values.backend) config.backend = values.backend as 'local' | 'orca'
  if (command === 'ui') {
    const { launchTui } = await import('./tui')
    await launchTui(project, ensureSupervisor, values.backend as 'local' | 'orca' | undefined)
    return
  }
  if (command === 'projects') {
    const { SavedProjects, nativeProjects } = await import('./projects')
    const { OrcaClient } = await import('../../src/cli')
    const projects = await new SavedProjects(undefined, config.backend === 'orca' ? () => nativeProjects(new OrcaClient(undefined, config.orca?.executable)) : undefined).list()
    output(values.json ? { projects } : projects.map((project, index) => `${index + 1}. ${project.name}\n   ${project.path}`).join('\n') || 'Сохранённых проектов пока нет. В TUI: :project /путь')
    return
  }
  if (command === 'doctor') {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    const runtime = await ModelRuntime.create()
    output({ project, node: process.version, executors: Object.keys(config.executors), piModels: (await runtime.getAvailable()).map(model => ({ provider: model.provider, model: model.id })) })
    return
  }
  if (command === 'agent') {
    const prompt = positionals.slice(1).join(' ')
    if (!prompt.trim()) throw new Error('Describe your request after pipeline agent')
    const abort = new AbortController(), cancel = () => abort.abort()
    process.once('SIGINT', cancel)
    try {
      const { runConsoleAgent } = await import('./agent')
      const source = values.file ? await readFile(resolve(project, values.file), 'utf8') : undefined
      const result = await runConsoleAgent(project, config, prompt, { file: values.file, source, runId: values.run, signal: abort.signal,
        call: async message => { await ensureSupervisor(project); return request(project, message) },
        onEvent: event => { if (!values.json && event.tool) console.error(event.kind + ': ' + event.tool) } })
      output(values.json ? result : [result.text, result.file ? 'План: ' + result.file : '', result.run ? 'Run: ' + result.run.id + ' · ' + result.run.status : ''].filter(Boolean).join('\n'))
    } finally { process.removeListener('SIGINT', cancel) }
    return
  }
  if (command === 'plan') {
    const goal = positionals.slice(1).join(' ')
    if (!goal.trim()) throw new Error('Describe the task after pipeline plan')
    const abort = new AbortController()
    const cancel = () => abort.abort(); process.once('SIGINT', cancel)
    const { createPlan } = await import('./planning')
    const result = await createPlan(project, config, goal, abort.signal, event => {
      if (!values.json && event.tool) console.error(`${event.kind}: ${event.tool}`)
    }, values.file).finally(() => process.removeListener('SIGINT', cancel))
    output({ file: result.file, name: result.scenario.name, steps: result.scenario.steps.length, sessionFile: result.sessionFile })
    return
  }
  if (command === 'diff' || command === 'accept') {
    if (!values.run || !values.isolated || (command === 'accept' && !values.digest)) throw new Error('Pass --run ID and --isolated PATH. Acceptance also requires the reviewed --digest.')
    const copy = await realpath(resolve(project, values.isolated))
    await ensureSupervisor(copy)
    const { runs } = await request(copy, { id: randomUUID(), command: 'status', runId: values.run }) as Dashboard
    const run = runs.find(item => item.id === values.run)
    if (!run) throw new Error('Unknown run')
    const result = await isolatedChanges(project, copy, run, command === 'accept' ? values.digest : undefined)
    output(values.json ? result : command === 'accept' ? 'Changes staged in ' + result.source : result.patch + '\nDigest: ' + result.digest)
    return
  }
  let source: string | undefined
  if (command === 'validate' || command === 'run') {
    if (!values.file) throw new Error('Pass --file scenario.pipeline.yaml')
    source = await readFile(resolve(project, values.file), 'utf8')
    const scenario = parseScenario(source)
    if (command === 'validate') { output({ valid: true, scope: 'schema-and-graph', name: scenario.name, steps: scenario.steps.length }); return }
    const memory = new RunStore(':memory:')
    try { await createBackend(memory, project, config).preflightScenario(scenario) } finally { memory.close() }
    if (values.isolated) {
      if (config.backend === 'orca' || workspaceRestrictionConflicts(scenario, project).length) throw new Error('Isolated console runs require a local scenario without an original-folder restriction')
      values['request-id'] ??= randomUUID()
      project = await prepareIsolated(project, resolve(project, values.isolated), source, values['request-id'], config)
      if (!values.json) output('Worktree: ' + project)
    }
  }
  await ensureSupervisor(project)
  if (command === 'send' || command === 'answer') {
    if (!values.run || !values.step || !values.text?.trim()) throw new Error('Pass --run ID --step ID --text message')
    if (command === 'answer' && !values.question) throw new Error('Pass --question ID from the waiting question')
    const result = await request(project, { id: values['request-id'] ?? randomUUID(), command: 'send', runId: values.run, stepId: values.step,
      text: values.text, questionId: values.question, messageId: values['message-id'] }) as { receipt: MessageReceipt; run: PipelineRun }
    output(values.json ? result : `Message ${result.receipt.id}: ${result.receipt.state}${result.receipt.error ? ' · ' + result.receipt.error : ''}. See status for delivery.`)
    return
  }
  if (command === 'status' || command === 'attach') {
    const result = await request(project, { id: randomUUID(), command: 'status', runId: values.run }) as Dashboard
    if (values.json) output(result)
    else output(result.runs.filter(run => !values.run || run.id === values.run).map(summary).join('\n\n') || 'No runs')
    if (command !== 'attach' && !values.watch) return
  } else if (command === 'shutdown') { output(await request(project, { id: randomUUID(), command })); return }
  else {
    const allowed = ['run', 'pause', 'resume', 'stop', 'retry', 'recover', 'reconcile', 'approve', 'assign', 'open']
    if (!allowed.includes(command)) throw new Error('Unknown command: ' + command)
    const result = await request(project, { id: values['request-id'] ?? randomUUID(), command, runId: values.run, stepId: values.step, agent: values.agent, source, backend: values.backend as 'local' | 'orca' | undefined, ...(command === 'approve' ? { resolution: values.reject ? 'reject' as const : 'approve' as const } : {}) }) as PipelineRun
    if (command === 'run' && values.isolated) await bindIsolated(originalProject, project, result.id)
    output(values.json ? result : summary(result))
    if (!values.watch) return
    values.run = result.id
  }
  let last = '', after = 0
  while (true) {
    const result = await request(project, { id: randomUUID(), command: 'status', after, runId: values.run }) as Dashboard
    const run = result.runs.find(run => run.id === values.run) ?? result.runs[0]
    if (!run) return
    const current = summary(run)
    if (values.json) { for (const event of result.events) output(event) }
    else if (current !== last) { output(current); last = current }
    after = result.events.at(-1)?.seq ?? after
    if (['done', 'failed', 'cancelled'].includes(run.status)) { process.exitCode = run.status === 'done' ? 0 : 1; return }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

void main().catch(error => { console.error(redactSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1 })
