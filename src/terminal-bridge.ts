import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RunStore } from '../packages/runtime/store'
import { request, type Request } from '../packages/core/terminal-ipc'
import type { PipelineRun, Workspace, HistoryQuery, RunSummary, UserMessage, MessageReceipt } from './types'

type Location = { workspace: Workspace; run: PipelineRun }
type Send = typeof request

// The plugin observes terminal-owned runs. It never restores them into its Coordinator.
export class TerminalRunBridge {
  private readonly locations = new Map<string, Location>()
  private polling = false
  constructor(private readonly send: Send = request) {}

  private async withStore<T>(workspace: Workspace, absent: T, read: (store: RunStore) => T): Promise<T> {
    if (workspace.hostId && workspace.hostId !== 'local') return absent
    const file = join(workspace.path, '.agent-pipeline', 'runtime', 'state.sqlite')
    const exists = await stat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!exists) return absent
    const store = new RunStore(file, true)
    try { return read(store) } finally { store.close() }
  }

  private load(store: RunStore, workspace: Workspace, id: string): PipelineRun | undefined {
    const run = store.get<PipelineRun>('run:' + id)
    if (!run || run.id !== id || run.workspacePath !== workspace.path) return undefined
    return { ...run, backend: store.get<{ backend?: 'local' | 'orca' }>('native-run:' + run.runId)?.backend ?? 'local',
      controller: 'terminal', workspaceId: workspace.id, sourceWorkspaceId: workspace.id }
  }

  async page(workspace: Workspace, query: HistoryQuery, limit: number): Promise<RunSummary[]> {
    return this.withStore(workspace, [], store => store.runPage(workspace.path, query, limit)
      .map(row => ({ ...row, workspaceId: workspace.id, controller: 'terminal' as const })))
  }

  async lookup(workspace: Workspace, id: string): Promise<PipelineRun | undefined> {
    const run = await this.withStore(workspace, undefined, store => this.load(store, workspace, id))
    if (run) this.locations.set(run.id, { workspace, run })
    return run
  }

  private read(workspace: Workspace, observeOlder = false): Promise<PipelineRun[]> {
    return this.withStore(workspace, [], store => {
      const ids = new Set(store.runPage(workspace.path, {}, 100).map(row => row.id))
      if (observeOlder) for (const tracked of this.locations.values()) {
        if (tracked.workspace.id === workspace.id && ['running', 'paused'].includes(tracked.run.status)) ids.add(tracked.run.id)
      }
      return [...ids].flatMap(id => this.load(store, workspace, id) ?? [])
    })
  }

  async discover(workspace: Workspace): Promise<PipelineRun[]> {
    const runs = await this.read(workspace)
    for (const run of runs) this.locations.set(run.id, { workspace, run })
    return runs
  }
  get(id: string): PipelineRun | undefined { return this.locations.get(id)?.run }

  async poll(): Promise<PipelineRun[]> {
    if (this.polling || this.locations.size === 0) return []
    this.polling = true
    const changed: PipelineRun[] = []
    try {
      const workspaces = new Map([...this.locations.values()].map(location => [location.workspace.id, location.workspace]))
      for (const workspace of workspaces.values()) for (const run of await this.read(workspace, true)) {
        const previous = this.locations.get(run.id)?.run
        this.locations.set(run.id, { workspace, run })
        if (!previous || previous.updatedAt !== run.updatedAt || previous.status !== run.status) changed.push(run)
      }
      return changed
    } finally { this.polling = false }
  }

  async control(id: string, command: string, fields: Pick<Request, 'stepId' | 'agent' | 'resolution'> = {}): Promise<PipelineRun> {
    const location = this.locations.get(id)
    if (!location) throw new Error('Запуск консоли не найден в выбранном проекте')
    let result: PipelineRun | undefined
    if (command === 'status') result = await this.lookup(location.workspace, id)
    else {
      try { result = await this.send(location.workspace.path, { id: randomUUID(), command, runId: id, ...fields }) as PipelineRun }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('Откройте консоль pipeline в этом проекте для управления запуском. Работа не перезапускалась.')
        throw error
      }
    }
    if (!result || result.id !== id) throw new Error('Ответ консоли не соответствует запуску')
    const run = { ...result, backend: location.run.backend, controller: 'terminal' as const, workspaceId: location.workspace.id, sourceWorkspaceId: location.workspace.id }
    this.locations.set(id, { workspace: location.workspace, run })
    return run
  }

  async message(id: string, stepId: string, message: UserMessage): Promise<{ run: PipelineRun; receipt: MessageReceipt }> {
    const location = this.locations.get(id)
    if (!location) throw new Error('Запуск консоли не найден в выбранном проекте')
    const result = await this.send(location.workspace.path, { id: randomUUID(), command: 'send', runId: id, stepId,
      messageId: message.id, text: message.text, questionId: message.questionId }) as { run: PipelineRun; receipt: MessageReceipt }
    if (result.run?.id !== id || result.receipt?.id !== message.id) throw new Error('Ответ консоли не соответствует сообщению')
    const run = { ...result.run, backend: location.run.backend, controller: 'terminal' as const, workspaceId: location.workspace.id, sourceWorkspaceId: location.workspace.id }
    this.locations.set(id, { workspace: location.workspace, run })
    return { run, receipt: result.receipt }
  }
}
