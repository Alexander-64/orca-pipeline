import type { ScenarioStep } from './types'

export function stepForAgent(step: ScenarioStep, agent: string): ScenarioStep {
  const preferences = agent === step.agent ? { model: step.model, effort: step.effort } : step.agentPreferences?.[agent]
  return { ...step, model: preferences?.model, effort: preferences?.effort }
}
