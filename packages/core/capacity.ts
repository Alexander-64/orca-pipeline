import type { PipelineTask, Scenario, ScenarioStep } from './types'

function activeAgent(task: PipelineTask): string | undefined {
  return task.attempts.at(-1)?.status === 'running' ? task.agent : undefined
}

export function hasCapacity(scenario: Scenario, tasks: Record<string, PipelineTask>, step: ScenarioStep): boolean {
  const active = Object.values(tasks).map(activeAgent).filter((agent): agent is string => Boolean(agent))
  if (active.length >= (scenario.maxConcurrent ?? 3)) return false
  const providerLimit = scenario.providerLimits?.[step.agent]
  if (providerLimit !== undefined && active.filter((agent) => agent === step.agent).length >= providerLimit) return false
  const hostLimit = scenario.hostLimits?.[step.placement.host]
  if (hostLimit !== undefined) {
    const hosts = new Map<string, number>()
    for (const candidate of scenario.steps) {
      const task = tasks[candidate.id]
      if (task && activeAgent(task)) hosts.set(candidate.placement.host, (hosts.get(candidate.placement.host) ?? 0) + 1)
    }
    if ((hosts.get(step.placement.host) ?? 0) >= hostLimit) return false
  }
  return true
}
