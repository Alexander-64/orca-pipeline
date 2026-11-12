import type { Metrics, PipelineRun } from './types'

export function metricsForRuns(runs: PipelineRun[]): Metrics {
  const byAgent = new Map<string, { agent: string; attempts: number; succeeded: number; failed: number }>()
  let attempts = 0
  let failovers = 0
  let completedSteps = 0
  let totalSteps = 0
  let durationMs = 0
  for (const run of runs) {
    durationMs += Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt))
    for (const step of run.scenario.steps) {
      const task = run.tasks[step.id]
      if (!task) continue
      totalSteps += 1
      if (task.status === 'done' || task.status === 'superseded') completedSteps += 1
      attempts += task.attempts.length
      failovers += Math.max(0, task.attempts.length - 1)
      for (const attempt of task.attempts) {
        const row = byAgent.get(attempt.agent) ?? { agent: attempt.agent, attempts: 0, succeeded: 0, failed: 0 }
        row.attempts += 1
        if (attempt.status === 'done') row.succeeded += 1
        if (attempt.status === 'failed') row.failed += 1
        byAgent.set(attempt.agent, row)
      }
    }
  }
  return {
    durationMs,
    attempts,
    failovers,
    completedSteps,
    totalSteps,
    successRate: totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0,
    byAgent: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent))
  }
}
