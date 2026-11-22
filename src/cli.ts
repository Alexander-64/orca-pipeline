import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ScenarioStep } from './types'
import { MemoryMutationJournal, type MutationJournal, type MutationRecord } from './mutations'

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (file: string, args: string[], cwd?: string, timeoutMs?: number) => Promise<CommandResult>

export const defaultRunner: CommandRunner = (file, args, cwd, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  execFile(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  }, (error, stdout, stderr) => {
    if (error && typeof error.code === 'number') {
      resolve({ code: error.code, stdout, stderr })
      return
    }
    if (error) {
      reject(new Error(`${file}: ${error.message}`))
      return
    }
    resolve({ code: 0, stdout, stderr })
  })
})

function payload(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`The command returned invalid JSON: ${output.slice(0, 300)}`)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(value: unknown, fallback: string): string {
  const root = record(value)
  const error = record(root.error)
  return typeof error.message === 'string' ? error.message : fallback
}

export function resolveOrcaExecutable(platform = process.platform, environment = process.env): string {
  if (environment.ORCA_CLI_COMMAND) return environment.ORCA_CLI_COMMAND
  if (environment.ORCA_DEV_REPO_ROOT) return 'orca-dev'
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

export function workspaceSelector(workspace: { id: string; kind: 'worktree' | 'folder' }): string {
  if (workspace.id.startsWith('identity:') || workspace.id.startsWith('folder:')) return workspace.id
  return `id:${workspace.id}`
}

export class OrcaClient {
  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly executable = resolveOrcaExecutable(),
    private readonly journal: MutationJournal = new MemoryMutationJournal()
  ) {}

  async call(args: string[], timeoutMs?: number): Promise<Record<string, unknown>> {
    const result = await this.runner(this.executable, [...args, '--json', '--full'], undefined, timeoutMs)
    const parsed = payload(result.stdout || result.stderr)
    const root = record(parsed)
    if (result.code !== 0 || root.ok === false) {
      const error = new Error(errorMessage(parsed, `Orca exited with code ${result.code}: ${result.stderr || result.stdout}`)) as Error & { details?: unknown }
      error.details = parsed
      throw error
    }
    return record(root.result)
  }

  private async executeMutation(record: MutationRecord, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.journal.put(record)
    try {
      const result = await this.call([...record.args, '--retry-request', record.requestId], timeoutMs)
      await this.journal.put({ ...record, status: 'completed', result })
      return result
    } catch (error) {
      if (error instanceof Error && 'details' in error) {
        await this.journal.put({ ...record, status: 'failed', error: error.message })
      }
      throw error
    }
  }

  private async recoverMutation(record: MutationRecord, original?: unknown): Promise<Record<string, unknown>> {
    let shown: Record<string, unknown>
    try {
      shown = await this.call(['orchestration', 'request-show', '--request', record.requestId])
    } catch {
      throw original instanceof Error ? original : new Error(`Could not recover mutation ${record.requestId}`)
    }
    const requestData = recordRequest(shown)
    const status = shown.state ?? shown.status ?? requestData.state ?? requestData.status
    if (status === 'completed') {
      const receipt = recordReceipt(shown, requestData)
      await this.journal.put({ ...record, status: 'completed', result: receipt })
      return receipt
    }
    if (status === 'pending') return this.executeMutation(record)
    const error = new Error(`Orca did not confirm mutation ${record.requestId}: ${String(status ?? 'absent')}${original instanceof Error ? `; ${original.message}` : ''}`)
    await this.journal.put({ ...record, status: 'failed', error: error.message })
    throw error
  }

  private async mutate(args: string[], timeoutMs?: number): Promise<Record<string, unknown>> {
    const mutation: MutationRecord = { requestId: randomUUID(), args, status: 'pending' }
    try {
      return await this.executeMutation(mutation, timeoutMs)
    } catch (error) {
      if (error instanceof Error && 'details' in error) throw error
      return this.recoverMutation(mutation, error)
    }
  }

  async recoverPending(): Promise<void> {
    const pending = (await this.journal.list()).filter((record) => record.status === 'pending')
    for (const record of pending) await this.recoverMutation(record)
  }

  async createRun(objective: string, coordinatorHandle: string): Promise<string> {
    const result = await this.mutate(['orchestration', 'run-create', '--objective', objective, '--from', coordinatorHandle])
    const id = record(result.run).id
    if (typeof id !== 'string') throw new Error('Orca did not return a Run ID')
    return id
  }

  async bindRun(runId: string, coordinatorHandle: string): Promise<void> {
    await this.mutate(['orchestration', 'run-use', '--id', runId, '--from', coordinatorHandle])
  }

  async createTask(runId: string, coordinatorHandle: string, step: ScenarioStep, spec: string, dependencies: string[]): Promise<string> {
    const result = await this.mutate([
      'orchestration', 'task-create', '--run', runId, '--from', coordinatorHandle,
      '--task-title', step.title, '--display-name', step.title,
      '--spec', spec, '--deps', JSON.stringify(dependencies)
    ])
    const id = record(result.task).id
    if (typeof id !== 'string') throw new Error(`Orca did not return a Task ID for ${step.id}`)
    return id
  }

  async createGate(runId: string, coordinatorHandle: string, taskId: string, question: string): Promise<string> {
    const result = await this.mutate([
      'orchestration', 'gate-create', '--task', taskId, '--question', question,
      '--options', JSON.stringify(['approve', 'reject']), '--from', coordinatorHandle
    ])
    const id = record(result.gate).id ?? result.id
    if (typeof id !== 'string') throw new Error(`Orca did not return a Gate ID for ${taskId}`)
    return id
  }

  async listGates(runId: string, taskId: string): Promise<Record<string, unknown>[]> {
    const result = await this.call(['orchestration', 'gate-list', '--run', runId, '--task', taskId])
    return Array.isArray(result.gates) ? result.gates.map(record) : []
  }

  async resolveGate(gateId: string, coordinatorHandle: string, resolution: 'approve' | 'reject'): Promise<void> {
    await this.mutate(['orchestration', 'gate-resolve', '--id', gateId, '--resolution', resolution, '--from', coordinatorHandle])
  }

  async listTasks(runId: string): Promise<Record<string, unknown>[]> {
    const result = await this.call(['orchestration', 'task-list', '--run', runId])
    return Array.isArray(result.tasks) ? result.tasks.map(record) : []
  }

  async preflight(step: ScenarioStep): Promise<void> {
    if (step.placement.host === 'local') return
    const environment = step.placement.host
    const status = await this.call(['status', '--environment', environment])
    const runtime = record(status.runtime)
    if (runtime.state !== 'ready') throw new Error(`Remote ${environment} is not ready: ${String(runtime.state ?? 'unknown')}`)
    const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : []
    if ((step.model || step.effort) && !capabilities.includes('orchestration.worker-launch-preferences.v1')) {
      throw new Error(`Remote ${environment} does not support model or effort for orchestration`)
    }
    if (step.placement.worktree === 'new-child' || step.placement.worktree === 'new-top-level') {
      await this.call(['repo', 'show', '--repo', step.placement.repo!, '--environment', environment])
    } else {
      await this.call(['worktree', 'show', '--worktree', step.placement.worktree, '--environment', environment])
    }
  }

  async startWorker(
    run: { runId: string; coordinatorHandle: string; workspacePath: string; workspaceSelector?: string },
    step: ScenarioStep,
    taskId: string,
    agent: string,
    retryOf?: string
  ): Promise<string> {
    await this.preflight(step)
    const worktree = step.placement.worktree === 'current' ? run.workspaceSelector ?? `path:${run.workspacePath}` : step.placement.worktree
    const args = [
      'orchestration', 'worker-start', '--run', run.runId, '--from', run.coordinatorHandle,
      '--task', taskId, '--agent', agent, '--worktree', worktree
    ]
    if (step.placement.host !== 'local') args.push('--on', step.placement.host)
    if (step.placement.repo) args.push('--repo', step.placement.repo)
    if (step.placement.name) args.push('--name', step.placement.name)
    if (step.placement.setup) args.push('--setup', step.placement.setup)
    if (step.model) args.push('--model', step.model)
    if (step.effort) args.push('--effort', step.effort)
    if (retryOf) args.push('--retry-of', retryOf)
    const result = await this.mutate(args, 180_000)
    const dispatch = record(result.dispatch)
    const launch = record(result.launch)
    const id = dispatch.id ?? result.dispatchId ?? result.dispatch_id ?? record(result.worker).id ?? launch.dispatchId
    if (typeof id !== 'string') throw new Error(`Orca did not return a Dispatch ID for ${step.id}: ${JSON.stringify(result).slice(0, 500)}`)
    return id
  }

  async workerOutput(dispatchId: string): Promise<string> {
    const result = await this.call(['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'auto', '--limit', '120'])
    return extractText(result).slice(-24_000)
  }

  async workerActivityDone(dispatchId: string): Promise<boolean> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId])
    const projection = record(result.projection)
    const stage = record(projection.stage)
    const observation = record(result.observation)
    return stage.activity === 'done' || observation.status === 'exited'
  }

  async sendWorker(dispatchId: string, subject: string, body: string, coordinatorHandle: string): Promise<void> {
    await this.mutate([
      'orchestration', 'send', '--from', coordinatorHandle, '--to', `dispatch:${dispatchId}`,
      '--subject', subject, '--body', body
    ])
  }

  async stopWorker(dispatchId: string): Promise<void> {
    await this.mutate(['orchestration', 'worker-stop', '--dispatch', dispatchId])
  }

  async releaseWorker(dispatchId: string): Promise<void> {
    await this.mutate(['orchestration', 'worker-release', '--dispatch', dispatchId])
  }
}

function recordRequest(value: Record<string, unknown>): Record<string, unknown> {
  return record(value.request)
}

function recordReceipt(value: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  return record(value.receipt ?? value.result ?? request.receipt ?? value)
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const root = record(value)
  for (const key of ['content', 'text', 'output', 'message', 'summary', 'result', 'transcript', 'messages', 'blocks', 'terminal', 'tail']) {
    if (root[key] !== undefined) {
      const text = extractText(root[key])
      if (text) return text
    }
  }
  const rows = root.rows ?? root.entries ?? root.records ?? root.lines
  return rows === undefined ? '' : extractText(rows)
}
