import type { Bead, PipelineRun, PipelineTask, Scenario } from './types'
import { defaultRunner, type CommandRunner } from './cli'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parse(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`bd returned invalid JSON: ${output.slice(0, 300)}`)
  }
}

function beadFrom(value: unknown): Bead | null {
  const raw = object(value)
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  return {
    id: raw.id,
    title: raw.title,
    status: typeof raw.status === 'string' ? raw.status : 'open',
    priority: typeof raw.priority === 'number' ? raw.priority : undefined,
    issueType: typeof raw.issue_type === 'string' ? raw.issue_type : typeof raw.type === 'string' ? raw.type : undefined,
    labels: Array.isArray(raw.labels) ? raw.labels.filter((label): label is string => typeof label === 'string') : undefined,
    parentId: typeof raw.parent_id === 'string' ? raw.parent_id : typeof raw.parent === 'string' ? raw.parent : undefined
  }
}

export class BeadsClient {
  constructor(
    private readonly cwd: string,
    private readonly runner: CommandRunner = defaultRunner,
    private readonly executable = 'bd'
  ) {}

  private async call(args: string[]): Promise<unknown> {
    const result = await this.runner(this.executable, [...args, '--json'], this.cwd, 60_000)
    const parsed = parse(result.stdout || result.stderr)
    if (result.code !== 0) {
      const error = object(parsed).error
      throw new Error(typeof error === 'string' ? error : result.stderr || result.stdout || `bd exited ${result.code}`)
    }
    return parsed
  }

  async list(): Promise<Bead[]> {
    const value = await this.call(['list', '--all', '--flat', '--limit', '200'])
    const rows = Array.isArray(value) ? value : object(value).issues
    return Array.isArray(rows) ? rows.map(beadFrom).filter((bead): bead is Bead => bead !== null) : []
  }

  async create(runId: string, step: Scenario['steps'][number], dependencies: string[]): Promise<string> {
    const args = [
      'create', step.title,
      '--description', step.spec,
      '--acceptance', step.acceptance.join('\n'),
      '--labels', 'agent-pipeline',
      '--metadata', JSON.stringify({ pipelineRun: runId, pipelineStep: step.id }),
      '--silent'
    ]
    if (dependencies.length) args.push('--deps', dependencies.join(','))
    const value = await this.call(args)
    if (typeof value === 'string') return value.trim()
    const raw = object(value)
    const id = raw.id ?? object(raw.issue).id
    if (typeof id !== 'string') throw new Error(`bd did not return an ID for ${step.id}`)
    return id
  }

  async sync(run: PipelineRun, task: PipelineTask): Promise<void> {
    if (!task.beadId) return
    if (task.status === 'done' || task.status === 'superseded') {
      const reason = task.status === 'done' ? 'Orca Task checks passed' : 'Superseded by a new repair and review cycle'
      await this.call(['close', task.beadId, '--reason', reason])
      return
    }
    const status = task.status === 'failed' || task.status === 'blocked'
      ? 'blocked'
      : task.status === 'running' || task.status === 'retrying' ? 'in_progress' : 'open'
    await this.call(['update', task.beadId, '--status', status])
  }

  async claim(beadId: string): Promise<void> {
    await this.call(['update', beadId, '--claim'])
  }

  async close(beadId: string, reason: string): Promise<void> {
    await this.call(['close', beadId, '--reason', reason])
  }

  async reopen(beadId: string): Promise<void> {
    await this.call(['reopen', beadId])
  }

  async comment(beadId: string, text: string): Promise<void> {
    await this.call(['comment', beadId, text])
  }
}
