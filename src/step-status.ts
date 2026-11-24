import type { StepStatus } from './types'
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
