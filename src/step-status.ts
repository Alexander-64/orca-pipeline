import type { PipelineRun, StepStatus } from './types'
import type { Message } from './i18n'

export const STATUS: Record<StepStatus, { label: Message; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  skipped: { label: "Skipped", tone: 'neutral' },
  pending: { label: "Waiting", tone: 'neutral' },
  ready: { label: "Ready", tone: 'accent' },
  running: { label: "Running", tone: 'accent' },
  retrying: { label: "Switching agents", tone: 'warning' },
  done: { label: "Done", tone: 'success' },
  failed: { label: "Error", tone: 'danger' },
  blocked: { label: "Blocked", tone: 'warning' },
  superseded: { label: "Superseded", tone: 'neutral' }
}

export function countRunSteps(run: PipelineRun) {
  const counts = { completed: 0, failed: 0, active: 0, waiting: 0, skipped: 0, remaining: 0 }
  for (const step of run.scenario.steps) {
    const status = run.tasks[step.id]?.status ?? 'pending'
    switch (status) {
      case 'done':
      case 'superseded': counts.completed++; break
      case 'failed': counts.failed++; break
      case 'skipped': counts.skipped++; break
      case 'running': counts.active++; break
      default: counts.waiting++
    }
  }
  counts.remaining = counts.waiting + counts.active
  return counts
}
