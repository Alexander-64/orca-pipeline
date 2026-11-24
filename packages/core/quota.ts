import type { Attempt, ScenarioStep } from './types'

export type UsageWindow = {
  id: string
  usedPercent: number
  resetsAt?: number
  observedAt: number
}

export type UsageReader = {
  read(agent: string): Promise<UsageWindow[]>
}

export function usageIsExhausted(windows: UsageWindow[], now: number, threshold: number, staleAfterMs = 300_000): boolean {
  return windows.some((window) => {
    if (window.resetsAt !== undefined && window.resetsAt <= now) return false
    if (window.usedPercent < threshold) return false
    return now - window.observedAt <= staleAfterMs || window.usedPercent >= 100
  })
}

export function chooseAvailableAgent(
  step: ScenarioStep,
  attempts: Attempt[],
  usage: Record<string, UsageWindow[]>,
  now: number,
  threshold = 95
): { agent?: string; reason?: string } {
  const used = new Set(attempts.map((attempt) => attempt.agent))
  const candidates = [step.agent, ...step.fallback].filter((agent) => !used.has(agent))
  const available = candidates.filter((agent) => !usageIsExhausted(usage[agent] ?? [], now, threshold))
  const agent = available[0]
  return {
    agent,
    reason: agent ? `${agent}: выбран по актуальной квоте (порог ${threshold}%)` : 'Нет агента с подтверждённой доступной квотой'
  }
}
