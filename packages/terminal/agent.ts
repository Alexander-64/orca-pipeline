import { mkdir, readFile, writeFile, link, unlink, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { parseScenario, serializeScenario } from '../core/scenario'
import type { PipelineRun } from '../core/types'
import type { Request } from '../core/terminal-ipc'
import type { RuntimeConfig } from '../runtime/config'
import { RunStore } from '../runtime/store'
import { createBackend } from '../runtime/factory'
import { runPi } from '../pi-adapter/session'
import { atomicJson } from '../runtime/files'

type Draft = { source: string; file: string }
type Call = (message: Request) => Promise<unknown>
type Control = 'run' | 'pause' | 'resume' | 'stop' | 'retry' | 'reconcile'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export class ConsoleController {
  draft?: Draft
  run?: PipelineRun
  selectedRunId?: string
  private controlling = false
  private startedRunId?: string
  private readonly turnId = randomUUID()
  constructor(readonly project: string, readonly config: RuntimeConfig, private readonly call: Call, initial: { draft?: Draft; runId?: string } = {}) { this.draft = initial.draft; this.selectedRunId = initial.runId }

  async inspect() { return { project: this.project, draft: this.draft, selectedRunId: this.selectedRunId, backend: this.config.backend ?? 'local', executors: Object.entries(this.config.executors).map(([id, executor]) => ({ id, kind: executor.kind, agent: executor.agent, model: executor.model })) } }
  async status() {
    const result = await this.call({ id: randomUUID(), command: 'status', runId: this.selectedRunId }) as { runs: PipelineRun[] }
    this.run = result.runs.find(run => run.id === this.selectedRunId)
    return result
  }
  async plan(source: string) { return this.save(source) }
  async update(source: string) { if (!this.draft) throw new Error('No selected draft; use plan first'); return this.save(source, this.draft) }
  private async save(source: string, previous?: Draft) {
    const scenario = parseScenario(source, { expandEvidence: false })
    const expanded = parseScenario(source)
    const memory = new RunStore(':memory:')
    try { await createBackend(memory, this.project, this.config).preflightScenario(expanded) } finally { memory.close() }
    if (previous && await readFile(previous.file, 'utf8') !== previous.source) throw new Error('Draft changed on disk; reopen it before updating')
    const normalized = serializeScenario(scenario)
    const directory = join(this.project, '.agent-pipeline/plans'); await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, randomUUID() + '.pipeline.yaml'), temporary = file + '.tmp'
    await writeFile(temporary, normalized, { flag: 'wx', mode: 0o600 })
    try { await link(temporary, file) } finally { await unlink(temporary) }
    this.draft = { file, source: normalized }
    return { file, hash: hash(normalized), scenario, started: false, activeRunUnchanged: this.selectedRunId }
  }
  async control(action: Control, operationId: string) {
    if (!['run', 'pause', 'resume', 'stop', 'retry', 'reconcile'].includes(action)) throw new Error('Unsupported console control; approvals require the explicit operator command')
    if (this.controlling) throw new Error('Another console control is in progress')
    this.controlling = true
    try {
      await this.status()
      if (action === 'run') {
        if (this.startedRunId) throw new Error('This conversation turn already started a run. Use status; another start requires a new user request.')
        if (!this.draft) throw new Error('No validated draft')
        if (this.run && ['running', 'paused'].includes(this.run.status)) throw new Error('Selected run is still active; attach or control it instead')
        if (await readFile(this.draft.file, 'utf8') !== this.draft.source) throw new Error('Draft changed on disk; reopen it before starting')
      } else if (!this.selectedRunId) throw new Error('Select a run explicitly with --run before controlling it')
      const proposed: Request = { id: 'console-' + hash(this.turnId + ':' + operationId).slice(0, 32), command: action, ...(action === 'run' ? { source: this.draft!.source, backend: this.config.backend ?? 'local' } : { runId: this.selectedRunId }) }
      const directory = join(this.project, '.agent-pipeline/console'); await mkdir(directory, { recursive: true, mode: 0o700 })
      const pendingFile = join(directory, 'pending-control.json')
      let message = proposed
      try {
        const file = await open(pendingFile, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify({ pid: process.pid, message })); await file.sync() } finally { await file.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const pending = JSON.parse(await readFile(pendingFile, 'utf8')) as { pid: number; message: Request }
        if (pending.pid !== process.pid) {
          try { process.kill(pending.pid, 0); throw new Error('Another console owns an unsettled control; inspect status before continuing') }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
        }
        const context = (request: Request) => JSON.stringify({ command: request.command, source: request.source, runId: request.runId, backend: request.backend })
        if (context(pending.message) !== context(proposed)) throw new Error('An earlier console control has an unknown outcome. Inspect status and reconcile that operation; no different control was sent.')
        message = pending.message // Replay the original operation identity after a lost receipt.
      }
      const result = await this.call(message) as PipelineRun
      this.run = result; this.selectedRunId = result.id
      if (action === 'run') this.startedRunId = result.id
      await atomicJson(join(directory, message.id + '.receipt.json'), { message, result, settledAt: new Date().toISOString() })
      await unlink(pendingFile).catch(error => { if (error.code !== 'ENOENT') throw error })
      return result
    } finally { this.controlling = false }
  }
}

export async function runConsoleAgent(project: string, config: RuntimeConfig, prompt: string, options: {
  call: Call; signal: AbortSignal; onEvent(event: { kind: string; tool?: string }): void
  file?: string; source?: string; runId?: string; sessionFile?: string
}) {
  const planner = Object.values(config.executors).find(executor => executor.kind === 'pi')
  if (!planner) throw new Error('Configure a Pi console/planner executor')
  const controller = new ConsoleController(project, config, options.call, { draft: options.file && options.source ? { file: resolve(project, options.file), source: options.source } : undefined, runId: options.runId })
  const response = await runPi({ cwd: project, prompt: `Current project: ${project}. Available executors: ${Object.keys(config.executors).join(', ')}. Start by inspecting current state.\nUser request: ${prompt}\nFor YAML use name, objective, commandPolicy and steps with id/title/spec/agent/needs/acceptance. Default to read-only checks pwd/ls. Use version: 2 only for outputSchema/when/join. Do not add approvals unless the task requires them. Plan or update alone must not start execution.`,
    readOnly: true, provider: planner.provider, model: planner.model, sessionDir: join(project, '.agent-pipeline/console/sessions'), resumeSessionFile: options.sessionFile,
    signal: options.signal, onEvent: options.onEvent,
    console: { inspect: () => controller.inspect(), status: () => controller.status(), plan: source => controller.plan(source), update: source => controller.update(source), control: (action, id) => controller.control(action, id) } })
  return { text: response.text, file: controller.draft?.file, source: controller.draft?.source, run: controller.run, sessionFile: response.sessionFile }
}
