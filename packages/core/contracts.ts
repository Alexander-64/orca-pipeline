import type { PipelineRun, PipelineTask, Scenario, ScenarioStep, UserMessage, MessageReceipt, WorkerQuestion, FailureInfo, Project } from './types'

export interface ProjectResolver {
  list(): Promise<Project[]>
  resolve(selector: string): Promise<Project>
}

// Structural ports: core never imports an Orca host API or agent SDK.
export interface ExecutionBackend {
  reconcile?(run: PipelineRun): Promise<void>
  preflightScenario?(scenario: Scenario): Promise<void>
  canStart?(run: PipelineRun, step: ScenarioStep, agent: string): boolean
  createRun(objective: string, owner: string): Promise<string>
  bindRun(runId: string, owner: string): Promise<void>
  createTask(runId: string, owner: string, step: ScenarioStep, spec: string, dependencies: string[]): Promise<string>
  reviseTask?(run: PipelineRun, step: ScenarioStep, revision: number, spec: string, dependencies: string[]): Promise<string>
  prepareRetry?(run: PipelineRun, step: ScenarioStep, task: PipelineTask): Promise<string | undefined>
  listTasks(runId: string): Promise<Record<string, unknown>[]>
  skipTask?(runId: string, owner: string, taskId: string, reason: string): Promise<void>
  createGate(runId: string, owner: string, taskId: string, question: string): Promise<string>
  listGates(runId: string, taskId: string): Promise<Record<string, unknown>[]>
  resolveGate(id: string, owner: string, resolution: 'approve' | 'reject'): Promise<void>
  startWorker(run: PipelineRun, step: ScenarioStep, taskId: string, agent: string, retryOf?: string, reuseTerminal?: string): Promise<string>
  prepareCheckpoint?(run: PipelineRun, step: ScenarioStep, taskId: string, body: string): Promise<void>
  workerOutput(id: string): Promise<string>
  workerActivityDone(id: string): Promise<boolean>
  workerFailure?(id: string): Promise<{ settled: boolean; failure?: FailureInfo } | undefined>
  settledResult?(id: string): Promise<Record<string, unknown> | undefined>
  observationIntervalMs?(id: string): number
  workerObservation?(id: string): Promise<{ activity: string; waitReason?: string; workerState?: string; questions?: WorkerQuestion[]; messages?: MessageReceipt[]; interaction?: 'pi' | 'native' | 'none' }>
  sendUserMessage?(id: string, message: UserMessage): Promise<MessageReceipt>
  sendWorker(id: string, subject: string, body: string, owner: string): Promise<void>
  stopWorker(id: string): Promise<void>
  abandonWorker?(id: string): Promise<void>
  releaseWorker(id: string): Promise<void>
  failedStartup?(runId: string, taskId: string): Promise<{ dispatchId: string; terminalHandle?: string; stage?: string } | undefined>
}

export interface BeadsPort {
  create(runId: string, step: ScenarioStep, dependencies: string[]): Promise<string>
  sync(run: PipelineRun, task: PipelineTask): Promise<void>
}

type PrStatus = { url: string; headRefOid: string; checks: { name: string; state: string }[] }
export interface PrPort {
  create(path: string, base: string): Promise<PrStatus>
  checks(url: string): Promise<PrStatus>
  merge(url: string, head: string): Promise<void>
}

export function workspaceSelector(workspace: { id: string; kind: 'worktree' | 'folder' }): string {
  if (workspace.id.startsWith('identity:') || workspace.id.startsWith('folder:')) return workspace.id
  return `id:${workspace.id}`
}
