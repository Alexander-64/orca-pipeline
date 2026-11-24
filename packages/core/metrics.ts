import type { Metrics, PipelineRun } from './types'

export function metricsForRuns(runs: PipelineRun[]): Metrics {
  const byAgent = new Map<string, { agent: string; attempts: number; succeeded: number; failed: number }>()
  let attempts = 0
  let failovers = 0
  let completedSteps = 0
  let skippedSteps = 0
  let totalSteps = 0
  let durationMs = 0
  for (const run of runs) {
    durationMs += Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt))
    for (const step of run.scenario.steps) {
      const task = run.tasks[step.id]
      if (!task) continue
      totalSteps += 1
      if (task.status === 'done' || task.status === 'superseded') completedSteps += 1
      if (task.status === 'skipped') skippedSteps += 1
      const revisions = [...(task.history ?? []), task]
      const allAttempts = revisions.flatMap(revision => revision.attempts)
      attempts += allAttempts.length
      failovers += revisions.reduce((sum, revision) => sum + revision.attempts.filter((attempt, index) => index > 0 && attempt.agent !== revision.attempts[index - 1].agent).length, 0)
      for (const attempt of allAttempts) {
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
    ...(skippedSteps ? { skippedSteps } : {}),
    totalSteps,
    successRate: totalSteps > skippedSteps ? Math.round((completedSteps / (totalSteps - skippedSteps)) * 100) : 0,
    byAgent: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent))
  }
}
