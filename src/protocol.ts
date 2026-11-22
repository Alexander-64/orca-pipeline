import type { Dashboard, PipelineRun, PlannerRun, Scenario } from './types'

export {}

declare module 'orca' {
  interface PluginRequests {
    'dashboard.get': { input: { workspaceId?: string }; output: Dashboard }
    'scenario.files': { input: { workspaceId: string }; output: { names: string[] } }
    'scenario.open': { input: { workspaceId: string; name: string }; output: { source: string } }
    'scenario.save': { input: { workspaceId: string; name: string; source: string; previous: string | null }; output: { saved: boolean } }
    'scenario.validate': { input: { source: string }; output: { scenario: Scenario } }
    'beads.action': { input: { workspaceId: string; id: string; action: 'claim' | 'close' | 'reopen' }; output: Dashboard }
    'plan.start': { input: { workspaceId: string; objective: string; agent: string }; output: { plan: PlannerRun } }
    'plan.list': { input: { workspaceId?: string }; output: { plans: PlannerRun[] } }
    'plan.get': { input: { id: string }; output: { plan: PlannerRun } }
    'run.start': { input: { workspaceId: string; source: string }; output: { run: PipelineRun } }
    'run.pause': { input: { id: string }; output: { run: PipelineRun } }
    'run.resume': { input: { id: string }; output: { run: PipelineRun } }
    'run.retry': { input: { id: string }; output: { run: PipelineRun } }
    'run.cancel': { input: { id: string }; output: { run: PipelineRun } }
    'run.tick': { input: { id: string }; output: { run: PipelineRun } }
    'run.resolve-gate': { input: { id: string; stepId: string; resolution: 'approve' | 'reject' }; output: { run: PipelineRun } }
    'run.switch-agent': { input: { id: string; stepId: string }; output: { run: PipelineRun } }
  }
  interface PluginPanelEvents {
    'run.changed': { run: PipelineRun }
    'plan.changed': { plan: PlannerRun }
  }
}
