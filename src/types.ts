export type Placement = {
  host: string
  worktree: string
  repo?: string
  name?: string
  setup?: 'run' | 'skip' | 'inherit'
}

export type ScenarioStep = {
  id: string
  title: string
  spec: string
  needs: string[]
  agent: string
  fallback: string[]
  model?: string
  effort?: string
  placement: Placement
  acceptance: string[]
  maxAttempts: number
  maxRepairs: number
  reviewAgent?: string
  role?: 'work' | 'evidence' | 'repair'
  gateFor?: string
  repairRound?: number
  routingRole?: string
  routingReason?: string
  approval?: string
}

export type CommandPolicy = {
  allowedCommands?: string[]
  readOnly?: boolean
}

export type AgentPolicy = {
  agent: string
  fallback: string[]
  model?: string
  effort?: string
}

export type Scenario = {
  name: string
  objective: string
  steps: ScenarioStep[]
  maxConcurrent?: number
  providerLimits?: Record<string, number>
  hostLimits?: Record<string, number>
  commandPolicy?: CommandPolicy
  quotaThreshold?: number
  roles?: Record<string, AgentPolicy>
  pullRequest?: {
    base: string
    merge?: boolean
    mergeApproval?: string
  }
}

export type StepStatus = 'pending' | 'ready' | 'running' | 'retrying' | 'done' | 'failed' | 'blocked' | 'superseded'
export type RunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export type Attempt = {
  dispatchId: string
  agent: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  reason?: string
  output?: string
  filesModified?: string[]
  checks?: { command: string; exitCode: number | null }[]
  selectionReason?: string
  artifactPath?: string
}

export type PipelineTask = {
  stepId: string
  taskId: string
  beadId?: string
  status: StepStatus
  agent: string
  attempts: Attempt[]
  error?: string
  gateId?: string
}

export type PipelineRun = {
  id: string
  runId: string
  coordinatorHandle: string
  workspaceId: string
  workspacePath: string
  workspaceSelector?: string
  scenario: Scenario
  status: RunStatus
  tasks: Record<string, PipelineTask>
  createdAt: string
  updatedAt: string
  error?: string
  pr?: {
    url: string
    headRefOid: string
    status: 'pending' | 'approved' | 'merged' | 'failed'
  }
}

export type Bead = {
  id: string
  title: string
  status: string
  priority?: number
  issueType?: string
  labels?: string[]
  parentId?: string
}

export type Workspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

export type Metrics = {
  durationMs: number
  attempts: number
  failovers: number
  completedSteps: number
  totalSteps: number
  successRate: number
  byAgent: { agent: string; attempts: number; succeeded: number; failed: number }[]
}

export type AgentOption = { id: string; label: string; status?: string; source?: string }

export type Dashboard = {
  agents?: AgentOption[]
  plans?: PlannerRun[]
  runs: PipelineRun[]
  beads: Bead[]
  beadsError?: string
  workspaces: Workspace[]
  metrics: Metrics
}

export type PlannerRun = {
  workspaceId?: string
  objective?: string
  createdAt?: string
  id: string
  runId: string
  dispatchId: string
  agent: string
  status: 'running' | 'done' | 'failed'
  source?: string
  error?: string
}

export const DEFAULT_SCENARIO = `name: demo-pipeline
objective: Make a small change and have an independent reviewer verify it
steps:
  - id: implement
    title: Implementation
    spec: |
      Describe the exact task, the scope of the changes and the expected result.
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
  - id: review
    title: Independent review
    needs: [implement]
    spec: |
      Review the previous step, run the checks and report any issues.
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
`
