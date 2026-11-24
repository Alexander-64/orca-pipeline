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
  agentPreferences?: Record<string, { model?: string; effort?: string }>
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
  outputSchema?: OutputSchema
  when?: Condition
  join?: 'all_success' | 'all_settled'
}

export type ResultValue = string | number | boolean
export type StructuredData = Record<string, ResultValue>
export type ReviewResult = { version: 1; verdict: 'SHIP' | 'FIX-FIRST' | 'BLOCKED'; findings: string }
export type FailureInfo = { version: 1; phase: 'executor' | 'validation' | 'acceptance' | 'review' | 'cancellation'; kind: 'quota' | 'auth' | 'network' | 'unknown'; message: string }
export type OutputSchema = Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean; enum?: ResultValue[] }>
export type Predicate = { step: string; field: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value: ResultValue }
export type Condition = Predicate | { all: Condition[] } | { any: Condition[] }

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
  version?: 1 | 2
  name: string
  objective: string
  layout?: Record<string, { x: number; y: number }>
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

export type StepStatus = 'pending' | 'ready' | 'running' | 'retrying' | 'done' | 'failed' | 'blocked' | 'superseded' | 'skipped'
export type RunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export type Attempt = {
  dispatchId: string
  taskId?: string
  outputPath?: string
  visibleWorkers?: boolean
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
  reportPath?: string
  data?: StructuredData
  review?: ReviewResult
  failure?: FailureInfo
  uncertainFiles?: string[]
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
  activity?: string
  activityObservedAt?: string
  waitReason?: string
  startup?: { dispatchId: string; terminalHandle?: string; stage?: string }
  questions?: WorkerQuestion[]
  messages?: MessageReceipt[]
  interaction?: 'pi' | 'native' | 'none'
  data?: StructuredData
  skipReason?: string
  unconfirmedStart?: boolean
  unconfirmedChecks?: boolean
  retryRequested?: boolean
  pendingTerminalHandle?: string
  retrySameAgent?: boolean
  recoveryAgent?: string
  revision?: number
  revisionPending?: boolean
  history?: TaskRevision[]
  repairPending?: boolean
}

export type TaskRevision = { revision: number; taskId: string; status: StepStatus; agent: string; attempts: Attempt[]; data?: StructuredData; error?: string; skipReason?: string; gateId?: string }

export type UserMessage = { id: string; text: string; questionId?: string }
export type MessageReceipt = { id: string; state: 'queued' | 'delivered' | 'rejected' | 'unknown'; at: string; error?: string; questionId?: string }
export type WorkerQuestion = { id: string; question: string; state: 'waiting' | 'answered' | 'cancelled'; askedAt: string; answeredAt?: string; answerMessageId?: string; toolCallId?: string }

export type PipelineRun = {
  stateVersion?: number
  controller?: 'terminal'
  backend?: 'local' | 'orca'
  id: string
  runId: string
  coordinatorHandle: string
  workspaceId: string
  workspacePath: string
  workspaceSelector?: string
  scenario: Scenario
  visibleWorkers?: boolean
  sourceWorkspaceId?: string
  status: RunStatus
  tasks: Record<string, PipelineTask>
  excludedSteps?: { step: ScenarioStep; task: PipelineTask; reason: string; excludedAt: string }[]
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
  skippedSteps?: number
  totalSteps: number
  successRate: number
  byAgent: { agent: string; attempts: number; succeeded: number; failed: number }[]
}

export type AgentModelCatalog = { observedAt: number; models: { id: string; label: string; efforts: { value: string; label: string }[] }[] }

export type AgentOption = { id: string; label: string; status?: string; source?: string }

export type Project = { id: string; name: string; path: string; workspaceId: string; kind: Workspace['kind'] }

export type RecoveryReport = { runId: string; status: 'checking' | 'continued' | 'blocked' | 'complete'; messages: string[]; updatedAt: string }

export type HistoryCursor = { createdAt: string; id: string }
export type RunSummary = HistoryCursor & { name: string; status: PipelineRun['status']; workspaceId: string; controller: 'plugin' | 'terminal' }
export type HistoryQuery = { workspaceId?: string; status?: string; search?: string; before?: HistoryCursor }
export type Dashboard = {
  projects?: Project[]
  agents?: AgentOption[]
  modelCatalogState?: 'undiscovered' | 'ready' | 'unsupported'
  unsupportedModelAgents?: string[]
  modelCatalogs?: Record<string, AgentModelCatalog>
  plans?: PlannerRun[]
  runs: PipelineRun[]
  runHistory?: PipelineRun[]
  beads: Bead[]
  beadsError?: string
  beadsEnabled?: boolean
  recoveryRunIds?: string[]
  recoveryWarning?: string
  workspaces: Workspace[]
  metrics: Metrics
}

export type PlannerRun = {
  model?: string
  effort?: string
  workspaceId?: string
  objective?: string
  createdAt?: string
  id: string
  runId: string
  dispatchId: string
  outputPath?: string
  visibleWorkers?: boolean
  agent: string
  status: 'running' | 'done' | 'failed'
  source?: string
  error?: string
}

export const DEFAULT_SCENARIO = `name: demo-pipeline
objective: Проверить небольшое изменение и независимо оценить результат
steps:
  - id: implement
    title: Реализация
    spec: |
      Опиши точную задачу исполнителя, границы изменений и ожидаемый результат.
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
  - id: review
    title: Независимая проверка
    needs: [implement]
    spec: |
      Проверь результат предыдущего шага, запусти проверки и доложи найденные проблемы.
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
`
