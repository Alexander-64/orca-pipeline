import { randomUUID } from 'node:crypto'
import { workspaceSelector, type OrcaClient } from './cli'
import { parseScenario } from './scenario'
import type { PlannerRun, ScenarioStep, Workspace } from './types'

type Deps = {
  client: OrcaClient
  notify: (plan: PlannerRun) => void
}

export function extractYaml(output: string): string {
  const blocks = [...output.matchAll(/```(?:yaml|yml)\s*\n([\s\S]*?)```/gi)]
  const source = blocks.at(-1)?.[1]?.trim()
  if (!source) throw new Error('Planner не вернул fenced YAML-блок')
  parseScenario(source)
  return `${source}\n`
}

// Task results survive transcript clipping. Hosts may serialize the result or
// wrap it in another result envelope; only a complete, valid body is usable.
export function extractTaskYaml(result: unknown): string | undefined {
  const seen = new Set<unknown>()
  while (result != null && !seen.has(result)) {
    seen.add(result)
    if (typeof result === 'string') {
      try { result = JSON.parse(result) } catch { return undefined }
      continue
    }
    if (typeof result !== 'object' || Array.isArray(result)) return undefined
    const record = result as Record<string, unknown>
    if (typeof record.body === 'string') {
      try { return extractYaml(record.body) } catch { /* Try a nested result, then transcript. */ }
    }
    result = record.result
  }
  return undefined
}

export class Planner {
  private readonly plans = new Map<string, PlannerRun>()
  private readonly ticking = new Set<string>()

  constructor(private readonly deps: Deps) {}

  get(id: string): PlannerRun {
    const plan = this.plans.get(id)
    if (!plan) throw new Error(`Planner ${id} не найден`)
    return plan
  }

  restore(plans: PlannerRun[]): void {
    for (const plan of plans) this.plans.set(plan.id, plan)
  }

  list(): PlannerRun[] {
    return [...this.plans.values()]
  }

  async start(workspace: Workspace, coordinatorHandle: string, objective: string, agent: string): Promise<PlannerRun> {
    if (!objective.trim()) throw new Error('Опишите цель для planner')
    const runId = await this.deps.client.createRun(`Составить pipeline: ${objective}`, coordinatorHandle)
    const step: ScenarioStep = {
      id: 'plan',
      title: 'Составить YAML-сценарий',
      spec: objective,
      needs: [],
      agent,
      fallback: [],
      placement: { host: 'local', worktree: 'current' },
      acceptance: ['YAML проходит проверку схемы'],
      maxAttempts: 1,
      maxRepairs: 0
    }
    const spec = [
      'Ты planner агентного pipeline. Не изменяй файлы и не запускай команды, меняющие workspace.',
      `Цель пользователя: ${objective}`,
      'Составь DAG из небольших независимых шагов. Для каждого шага укажи самодостаточный spec, agent, fallback, placement и объективные acceptance-команды. Используй local/current, если пользователь явно не указал remote. Добавь отдельный независимый review для важных изменений. Не выдумывай имена remote hosts, модели и команды проекта.',
      'В финальном ответе верни ровно один блок ```yaml с полями name, objective и steps. Каждый step: id, title, spec, agent, fallback, placement, acceptance; при необходимости needs, model, effort, maxAttempts. Не добавляй пояснений после YAML.',
      'Затем отправь worker_done с реальным outcome.'
    ].join('\n\n')
    const taskId = await this.deps.client.createTask(runId, coordinatorHandle, step, spec, [])
    const dispatchId = await this.deps.client.startWorker(
      { runId, coordinatorHandle, workspacePath: workspace.path, workspaceSelector: workspaceSelector(workspace) },
      step,
      taskId,
      agent
    )
    const plan: PlannerRun = { id: randomUUID(), runId, dispatchId, agent, workspaceId: workspace.id, objective, createdAt: new Date().toISOString(), status: 'running' }
    this.plans.set(plan.id, plan)
    this.deps.notify(plan)
    void this.tick(plan.id)
    return plan
  }

  async tick(id: string): Promise<void> {
    if (this.ticking.has(id)) return
    const plan = this.get(id)
    if (plan.status !== 'running') return
    this.ticking.add(id)
    try {
      const tasks = await this.deps.client.listTasks(plan.runId)
      const status = String(tasks[0]?.status ?? '').toLowerCase()
      if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
        plan.source = extractTaskYaml(tasks[0]?.result)
          ?? extractYaml(await this.deps.client.workerOutput(plan.dispatchId))
        plan.status = 'done'
        await this.deps.client.releaseWorker(plan.dispatchId).catch(() => undefined)
        this.deps.notify(plan)
      } else if (['failed', 'stopped', 'cancelled', 'canceled'].includes(status)) {
        plan.status = 'failed'
        plan.error = await this.deps.client.workerOutput(plan.dispatchId).catch(() => 'Planner завершился с ошибкой')
        this.deps.notify(plan)
      }
    } catch (error) {
      plan.status = 'failed'
      plan.error = error instanceof Error ? error.message : String(error)
      this.deps.notify(plan)
    } finally {
      this.ticking.delete(id)
    }
  }
}
