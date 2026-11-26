import type { Dashboard, PipelineRun, PlannerRun, Scenario } from './types'

export {}

declare module 'orca' {
  interface PluginRequests {
    'dashboard.get': { input: { workspaceId?: string; selectedRunId?: string }; output: Dashboard }
    'history.list': { input: import('./types').HistoryQuery; output: { rows: import('./types').RunSummary[]; more: boolean } }
    'history.open': { input: { workspaceId: string; id: string }; output: { run: PipelineRun } }
    'editor.open': { input: { workspaceId: string; source: string }; output: { path: string } }
    'editor.publish': { input: { source: string; workspaceId?: string }; output: { ok: true } }
    'scenario.files': { input: { workspaceId: string }; output: { names: string[] } }
    'scenario.open': { input: { workspaceId: string; name: string }; output: { source: string } }
    'scenario.save': { input: { workspaceId: string; name: string; source: string; previous: string | null }; output: { saved: boolean } }
    'scenario.validate': { input: { source: string }; output: { scenario: Scenario } }
    'beads.action': { input: { workspaceId: string; id: string; action: 'claim' | 'close' | 'reopen' }; output: Dashboard }
    'plan.start': { input: { workspaceId: string; objective: string; agent: string; model?: string; effort?: string }; output: { plan: PlannerRun } }
    'plan.list': { input: { workspaceId?: string }; output: { plans: PlannerRun[] } }
    'plan.open': { input: { id: string }; output: { opened: true } }
    'plan.get': { input: { id: string }; output: { plan: PlannerRun } }
    'run.repair': { input: { id: string }; output: { dashboard: Dashboard; report: import('./types').RecoveryReport } }
    'run.diff': { input: { id: string }; output: { patch: string; digest: string; source: string; files: string[] } }
    'run.accept': { input: { id: string; digest: string }; output: { accepted: true } }
    'run.start': { input: { workspaceId: string; source: string; separateWorkspace?: boolean }; output: { run: PipelineRun } }
    'run.open': { input: { id: string; dispatchId?: string }; output: { opened: true } }
    'run.assign-agent': { input: { id: string; stepId: string; agent: string }; output: { run: PipelineRun } }
    'run.apply-agents': { input: { id: string; source: string }; output: { run: PipelineRun } }
    'run.refresh-pending-context': { input: { id: string; stepId: string }; output: { run: PipelineRun } }
    'run.exclude-invalid-steps': { input: { id: string; stepIds: string[]; reason: string }; output: { run: PipelineRun } }
    'run.pause': { input: { id: string }; output: { run: PipelineRun } }
    'run.message': { input: { id: string; stepId: string; messageId: string; text: string; questionId?: string }; output: { run: PipelineRun; receipt: import('./types').MessageReceipt } }
    'run.resume': { input: { id: string }; output: { run: PipelineRun } }
    'run.retry': { input: { id: string }; output: { run: PipelineRun } }
    'run.recover': { input: { id: string; stepId: string }; output: { run: PipelineRun } }
    'run.cancel': { input: { id: string }; output: { run: PipelineRun } }
    'run.tick': { input: { id: string }; output: { run: PipelineRun } }
    'run.resolve-gate': { input: { id: string; stepId: string; resolution: 'approve' | 'reject' }; output: { run: PipelineRun } }
    'run.switch-agent': { input: { id: string; stepId: string }; output: { run: PipelineRun } }
  }
  interface PluginPanelEvents {
    'recovery.changed': { report: import('./types').RecoveryReport }
    'run.changed': { run: PipelineRun }
    'plan.changed': { plan: PlannerRun }
    'scenario.changed': { source: string; workspaceId?: string }
  }
}
