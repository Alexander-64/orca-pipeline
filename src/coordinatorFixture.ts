import type { ArtifactStore } from './artifacts'
import type { BeadsClient } from './beads'
import type { OrcaClient } from './cli'
import { Coordinator } from './coordinator'
import type { UsageReader } from './quota'
import type { PrClient } from './pr'
import type { PipelineRun, Workspace } from './types'

export const fixtureWorkspace: Workspace = {
  id: 'repo::/work',
  kind: 'worktree',
  name: 'fixture',
  path: '/work',
  branch: 'main',
  hostId: null
}

export function coordinatorFixture(options: { startError?: string; stopError?: string; handoffError?: string; usage?: UsageReader; artifacts?: ArtifactStore; pr?: PrClient } = {}) {
  const statuses = new Map<string, string>()
  const gates = new Map<string, { id: string; status: string; resolution?: string }>()
  const dependenciesByTask = new Map<string, string[]>()
  const dispatchTasks = new Map<string, string>()
  const starts: { taskId: string; agent: string; retryOf?: string }[] = []
  const stops: string[] = []
  const handoffs: string[] = []
  const beadOrder: string[] = []
  const saved: PipelineRun[] = []
  const state = { output: 'usage limit reached; partial work saved', activityDone: false, binds: 0 }
  let sequence = 0
  const client = {
    createRun: async () => 'run_1',
    bindRun: async () => { state.binds += 1 },
    createTask: async (_run: string, _handle: string, step: { id: string }, _spec: string, dependencies: string[]) => {
      dependenciesByTask.set(`task_${step.id}`, dependencies)
      statuses.set(`task_${step.id}`, dependencies.length ? 'pending' : 'ready')
      return `task_${step.id}`
    },
    createGate: async (_run: string, _handle: string, taskId: string) => {
      const gate = { id: `gate_${taskId}`, status: 'pending' }
      gates.set(taskId, gate)
      return gate.id
    },
    listGates: async (_run: string, taskId: string) => {
      const gate = gates.get(taskId)
      return gate ? [gate] : []
    },
    resolveGate: async (gateId: string, _handle: string, resolution: string) => {
      const gate = [...gates.values()].find((candidate) => candidate.id === gateId)
      if (gate) {
        gate.resolution = resolution
        gate.status = resolution === 'approve' ? 'approved' : 'rejected'
      }
    },
    listTasks: async () => {
      for (const [taskId, status] of statuses) {
        if (status === 'pending' && (dependenciesByTask.get(taskId) ?? []).every((id) => statuses.get(id) === 'completed')) {
          statuses.set(taskId, 'ready')
        }
      }
      return [...statuses].map(([id, status]) => ({ id, status }))
    },
    startWorker: async (_run: unknown, _step: unknown, taskId: string, agent: string, retryOf?: string) => {
      if (options.startError) throw new Error(options.startError)
      starts.push({ taskId, agent, retryOf })
      sequence += 1
      const dispatchId = `dispatch_${sequence}`
      dispatchTasks.set(dispatchId, taskId)
      statuses.set(taskId, 'dispatched')
      return dispatchId
    },
    sendWorker: async (_id: string, _subject: string, body: string) => {
      if (options.handoffError) throw new Error(options.handoffError)
      handoffs.push(body)
    },
    workerOutput: async () => state.output,
    workerActivityDone: async () => state.activityDone,
    releaseWorker: async () => undefined,
    stopWorker: async (dispatchId: string) => {
      if (options.stopError) throw new Error(options.stopError)
      stops.push(dispatchId)
      const taskId = dispatchTasks.get(dispatchId)
      if (taskId) statuses.set(taskId, 'failed')
    }
  } as unknown as OrcaClient
  const beads = {
    create: async (_run: string, step: { id: string }) => {
      beadOrder.push(step.id)
      return `bd_${step.id}`
    },
    sync: async () => undefined,
    list: async () => [],
    comment: async () => undefined
  } as unknown as BeadsClient
  const coordinator = new Coordinator({
    client,
    beadsFor: () => beads,
    usage: options.usage,
    artifacts: options.artifacts,
    pr: options.pr,
    save: async (run) => { saved.push(structuredClone(run)) },
    notify: () => undefined,
    log: () => undefined
  })
  return { coordinator, client, statuses, starts, stops, handoffs, beadOrder, saved, state, gates }
}
