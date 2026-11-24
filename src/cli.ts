import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import type { ScenarioStep, Workspace, PipelineRun, PipelineTask, WorkerQuestion, UserMessage, MessageReceipt } from './types'
import { MemoryMutationJournal, type MutationJournal, type MutationRecord } from './mutations'
import { ArtifactStore } from './artifacts'
import { checkpointFile, taskSpec } from './scenario'

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (file: string, args: string[], cwd?: string, timeoutMs?: number) => Promise<CommandResult>
type OwnedTerminal = { handle: string; incarnationId: string; worktreeId: string; worktreePath: string; runId: string; taskId: string; agent: string }
function operationUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export const defaultRunner: CommandRunner = (file, args, cwd, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  execFile(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  }, (error, stdout, stderr) => {
    if (error && typeof error.code === 'number') {
      resolve({ code: error.code, stdout, stderr })
      return
    }
    if (error) {
      reject(new Error(`${file}: ${error.message}`))
      return
    }
    resolve({ code: 0, stdout, stderr })
  })
})

function payload(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`Команда вернула не JSON: ${output.slice(0, 300)}`)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(value: unknown, fallback: string): string {
  const root = record(value)
  const error = record(root.error)
  const cause = record(error.data).cause
  if (typeof cause === 'string') return `${typeof error.message === 'string' ? error.message : fallback} ${cause}`
  return typeof error.message === 'string' ? error.message : typeof record(root.result).lastError === 'string' ? record(root.result).lastError as string : fallback
}

export function resolveOrcaExecutable(platform = process.platform, environment = process.env): string {
  if (environment.ORCA_CLI_COMMAND) return environment.ORCA_CLI_COMMAND
  if (environment.ORCA_DEV_REPO_ROOT) return 'orca-dev'
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

export function workspaceSelector(workspace: { id: string; kind: 'worktree' | 'folder' }): string {
  if (workspace.id.startsWith('identity:') || workspace.id.startsWith('folder:')) return workspace.id
  return `id:${workspace.id}`
}

function argument(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  return index < 0 ? undefined : args[index + 1]
}

function visibleLaunchId(runId: string, taskId: string, retryOf: string | undefined, agent: string | undefined): string {
  return 'pipeline-launch-' + createHash('sha256').update(JSON.stringify([runId, taskId, retryOf ?? null, agent])).digest('hex').slice(0, 32)
}

function isVisibleLaunch(entry: MutationRecord): boolean {
  return /^pipeline-launch-[0-9a-f]{32}$/.test(entry.requestId) && entry.args[0] === 'agent' && entry.args[1] === 'launch' && !entry.args.includes('--prompt')
}

function launchMatches(entry: MutationRecord, runs: PipelineRun[]) {
  const agent = argument(entry.args, '--agent')
  return runs.flatMap(run => Object.values(run.tasks).flatMap(task => {
    const owner = entry.launch
    if (owner && (owner.runId !== run.runId || owner.taskId !== task.taskId)) return []
    const retries = owner ? [owner.retryOf] : [undefined, ...task.attempts.map(attempt => attempt.dispatchId), task.startup?.dispatchId]
    const matches = (retry: string | undefined) => visibleLaunchId(run.runId, task.taskId, retry, agent) === entry.requestId
    return retries.some(matches) ? [{ run, task, retryOf: retries.find(matches) }] : []
  }))
}

function receiptOwners(entry: MutationRecord, runs: PipelineRun[]): PipelineRun[] {
  if (isVisibleLaunch(entry)) return launchMatches(entry, runs).map(match => match.run)
  if (entry.args[0] !== 'orchestration') return []
  const native = argument(entry.args, '--run') ?? (entry.args[1] === 'run-use' ? argument(entry.args, '--id') : undefined)
  const dispatch = argument(entry.args, '--dispatch')
  if (native) return runs.filter(run => run.runId === native)
  if (dispatch) return runs.filter(run => Object.values(run.tasks).some(task => task.startup?.dispatchId === dispatch || task.attempts.some(attempt => attempt.dispatchId === dispatch)))
  const owner = argument(entry.args, '--from')
  return runs.filter(run => !!owner && run.coordinatorHandle === owner && entry.args[1] !== 'run-create')
}

function hasSavedLaunchOwner(entry: MutationRecord, runs: PipelineRun[]): boolean {
  const owner = entry.launch
  return owner !== undefined && runs.some(run => run.runId === owner.runId && Object.values(run.tasks).some(task => task.taskId === owner.taskId))
}

export class OrcaClient {
  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly executable = resolveOrcaExecutable(),
    private readonly journal: MutationJournal = new MemoryMutationJournal()
  ) {}

  async call(args: string[], timeoutMs?: number): Promise<Record<string, unknown>> {
    const result = await this.runner(this.executable, [...args, '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], undefined, timeoutMs)
    const parsed = payload(result.stdout || result.stderr)
    const root = record(parsed)
    if (result.code !== 0 || root.ok === false) {
      const error = new Error(errorMessage(parsed, `Orca завершила команду с кодом ${result.code}: ${result.stderr || result.stdout}`)) as Error & { details?: unknown }
      error.details = parsed
      throw error
    }
    return record(root.result)
  }

  private async executeMutation(record: MutationRecord, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.journal.put(record)
    try {
      const result = await this.call([...record.args, '--retry-request', record.requestId], timeoutMs)
      await this.journal.put({ ...record, status: 'completed', result })
      return result
    } catch (error) {
      if (error instanceof Error && 'details' in error) {
        const result = recordResult(error)
        await this.journal.put({ ...record, status: 'failed', error: error.message, ...(Object.keys(result).length ? { result } : {}) })
      }
      throw error
    }
  }

  private async recoverMutation(record: MutationRecord, original?: unknown): Promise<Record<string, unknown>> {
    let shown: Record<string, unknown>
    try {
      shown = await this.call(['orchestration', 'request-show', '--request', record.requestId])
    } catch {
      throw original instanceof Error ? original : new Error(`Не удалось восстановить mutation ${record.requestId}`)
    }
    const requestData = recordRequest(shown)
    const status = shown.state ?? shown.status ?? requestData.state ?? requestData.status
    if (status === 'completed') {
      const receipt = recordReceipt(shown, requestData)
      await this.journal.put({ ...record, status: 'completed', result: receipt })
      return receipt
    }
    if (status === 'pending') return this.executeMutation(record)
    const error = new Error(`Orca не подтвердила mutation ${record.requestId}: ${String(status ?? 'absent')}${original instanceof Error ? `; ${original.message}` : ''}`)
    await this.journal.put({ ...record, status: 'failed', error: error.message })
    throw error
  }

  async mutationReceipt(requestId: string): Promise<MutationRecord | undefined> {
    return (await this.journal.list()).find(record => record.requestId === requestId)
  }

  private async mutate(args: string[], timeoutMs?: number, requestId: string = randomUUID()): Promise<Record<string, unknown>> {
    const previous = await this.mutationReceipt(requestId)
    if (previous) {
      if (JSON.stringify(previous.args) !== JSON.stringify(args)) throw new Error('Mutation identity reused with different arguments')
      if (previous.status === 'completed') return previous.result ?? {}
      if (previous.status === 'failed') throw new Error(previous.error ?? 'Native mutation previously failed')
      return this.recoverMutation(previous)
    }
    const mutation: MutationRecord = { requestId, args, status: 'pending' }
    try {
      return await this.executeMutation(mutation, timeoutMs)
    } catch (error) {
      if (error instanceof Error && 'details' in error) throw error
      return this.recoverMutation(mutation, error)
    }
  }

  async recoverPending(belongs: (entry: MutationRecord) => boolean = () => true): Promise<void> {
    const pending = (await this.journal.list()).filter(record => record.status === 'pending' && belongs(record))
    for (const record of pending) {
      if (record.args[0] !== 'orchestration') throw new Error(`Resource operation ${record.requestId} has an unconfirmed receipt; inspect the existing terminal before retrying. No new resource was created.`)
      await this.recoverMutation(record)
    }
  }

  // Explicit user-triggered repair. A launch-only receipt never contains task input;
  // retirement is allowed only after the native Task and Dispatch ledger agree.
  async pendingScope(runs: PipelineRun[]) {
    const pending = (await this.journal.list()).filter(entry => entry.status === 'pending')
    const affected = new Set<string>()
    const orphanedLaunches = new Set<string>()
    let ambiguous: string | undefined
    for (const entry of pending) {
      const owners = receiptOwners(entry, runs)
      if (!owners.length && isVisibleLaunch(entry) && !hasSavedLaunchOwner(entry, runs)) {
        // No current task has this launch identity. Keep the receipt for inspection,
        // but it cannot be replayed or block scheduling of other tasks.
        orphanedLaunches.add(entry.requestId)
        continue
      }
      if (owners.length !== 1) ambiguous ??= entry.requestId
      for (const owner of owners) affected.add(owner.id)
    }
    return { ambiguous, affected, orphanedLaunches }
  }

  async repairPendingLaunches(runs: PipelineRun[], selectedId?: string): Promise<string[]> {
    const notes: string[] = []
    const journal = await this.journal.list()
    const { orphanedLaunches } = await this.pendingScope(runs)
    const belongs = (entry: MutationRecord) => !orphanedLaunches.has(entry.requestId) && (!selectedId || receiptOwners(entry, runs).some(run => run.id === selectedId))
    for (const entry of journal.filter(entry => belongs(entry) && entry.status === 'pending' && entry.args[0] === 'orchestration')) await this.recoverMutation(entry)
    for (const entry of (await this.journal.list()).filter(entry => belongs(entry) && entry.args[0] !== 'orchestration' && (entry.status === 'pending' || record(entry.result?.pipelineRecovery).kind))) {
      const flag = (name: string) => { const index = entry.args.indexOf(name); return index < 0 ? undefined : entry.args[index + 1] }
      if (entry.args[0] !== 'agent' || entry.args[1] !== 'launch' || entry.args.includes('--prompt')) throw new Error(`Не удалось автоматически сверить операцию ${entry.requestId}: требуется подтверждение её результата.`)
      const agent = flag('--agent')
      const matches = launchMatches(entry, runs)
      if (matches.length !== 1) throw new Error(`Операция ${entry.requestId} не сопоставлена единственной сохранённой задаче.`)
      const { run, task, retryOf } = matches[0]
      if (entry.status !== 'pending' && !task.unconfirmedStart) continue
      const step = run.scenario.steps.find(step => step.id === task.stepId)
      const worktree = step?.placement.worktree === 'current' ? run.workspaceSelector ?? `path:${run.workspacePath}` : step?.placement.worktree
      if (!step || flag('--worktree') !== worktree || ![step.agent, ...step.fallback].includes(agent ?? '') || step.placement.host !== 'local') throw new Error('Сохранённая операция не соответствует агенту и рабочей папке шага.')
      const listed = await this.call(['orchestration', 'worker-list', '--run', run.runId])
      if (!Array.isArray(listed.workers)) throw new Error('Orca не вернула полный список исполнителей; восстановление остановлено.')
      const known = new Set(task.attempts.map(attempt => attempt.dispatchId))
      if (task.startup) known.add(task.startup.dispatchId)
      const workers = listed.workers.map(record).filter(worker => worker.taskId === task.taskId && !known.has(String(worker.dispatchId)))
      if (workers.length > 1) throw new Error('Для задачи обнаружены несколько неизвестных исполнителей. Повторный запуск не выполнялся.')
      if (workers.length === 1) {
        const id = workers[0].dispatchId
        const provider = record(record(workers[0].projection).provider).id ?? workers[0].agent
        const observedAgent = typeof provider === 'string' ? provider.split('/')[0] : undefined
        if (!observedAgent || observedAgent !== agent) throw new Error('Агент найденного исполнителя не соответствует сохранённой операции.')
        if (typeof id !== 'string') throw new Error('У найденного исполнителя нет подтверждённого Dispatch ID.')
        const shown = await this.call(['orchestration', 'worker-show', '--dispatch', id])
        const dispatch = record(shown.dispatch), worker = record(shown.worker)
        const accepted = Array.isArray(worker.effects) && worker.effects.some(effect => record(effect).kind === 'dispatch_input' && record(effect).state === 'accepted')
        if (dispatch.id !== id || dispatch.runId !== run.runId || (dispatch.taskId ?? dispatch.task_id) !== task.taskId || (dispatch.retryOfDispatchId ?? undefined) !== retryOf || !accepted) throw new Error('Найденный исполнитель ещё не подтвердил приём задания.')
        await this.journal.put({ ...entry, status: 'completed', result: { recoveredDispatchId: id, pipelineRecovery: { kind: 'adopted', runId: run.runId, taskId: task.taskId } } })
        task.attempts.push({ dispatchId: id, agent: observedAgent, status: 'running', startedAt: typeof dispatch.dispatchedAt === 'string' ? dispatch.dispatchedAt : new Date().toISOString() })
        task.status = 'running'; task.agent = observedAgent; task.recoveryAgent = undefined; task.unconfirmedStart = undefined; task.error = undefined; task.startup = undefined
        notes.push(`${step.title}: найден уже запущенный исполнитель; повтор не создавался.`)
      } else {
        const native = (await this.listTasks(run.runId)).find(item => item.id === task.taskId)
        if (!native || !['ready', 'pending'].includes(String(native.status)) || task.attempts.at(-1)?.status === 'running') throw new Error(`${step.title}: не подтверждено, что задача свободна для запуска.`)
        const identity = record(entry.result?.pipelineLaunchTerminal)
        if (typeof identity.handle === 'string' && typeof identity.incarnationId === 'string') {
          const shown = record((await this.call(['terminal', 'show', '--terminal', identity.handle])).terminal)
          if (shown.handle !== identity.handle || shown.incarnationId !== identity.incarnationId || shown.worktreeId !== identity.worktreeId || shown.worktreePath !== identity.worktreePath || shown.agentIdentity !== agent || shown.connected !== true || shown.writable !== true || record(shown.agentWait).reason) throw new Error('Исходное окно изменилось или ожидает действия пользователя. Новое окно не создавалось.')
          await this.call(['terminal', 'wait', '--terminal', identity.handle, '--for', 'tui-idle', '--timeout-ms', '15000'], 20_000)
          const owned = { ...identity, runId: run.runId, taskId: task.taskId, agent }
          await this.journal.put({ ...entry, status: 'completed', result: { ...entry.result, pipelineOwnedTerminal: owned, pipelineRecovery: { kind: 'ready-terminal', runId: run.runId, taskId: task.taskId } } })
          notes.push(`${step.title}: восстановлено исходное окно агента.`)
        } else {
        await this.journal.put({ ...entry, status: 'failed', error: 'Проверено: запуск окна не передал задание; Task свободен, неизвестных Dispatch нет.', result: { pipelineRecovery: { kind: 'not-dispatched', runId: run.runId, taskId: task.taskId } } })
        }

        task.status = 'failed'; task.unconfirmedStart = undefined; task.pendingTerminalHandle = undefined
        run.status = 'failed'
        notes.push(`${step.title}: подтверждено, что задание не было запущено.`)
      }
      run.updatedAt = new Date().toISOString()
    }
    await this.recoverPending(belongs)
    return notes
  }

  async reconcile(run: PipelineRun): Promise<void> {
    await this.recoverPending(entry => receiptOwners(entry, [run]).length === 1)
    const journal = await this.journal.list()
    for (const task of Object.values(run.tasks).filter(task => task.unconfirmedStart)) {
      const known = new Set(task.attempts.map(attempt => attempt.dispatchId))
      const expectedRetry = task.startup?.dispatchId ?? task.attempts.at(-1)?.dispatchId
      const flag = (args: string[], name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
      const operations = journal.filter(entry => entry.args[0] === 'orchestration' && entry.args[1] === 'worker-start' && flag(entry.args, '--run') === run.runId && flag(entry.args, '--task') === task.taskId && flag(entry.args, '--retry-of') === expectedRetry)
      const completed = operations.filter(entry => (entry.status === 'completed' || entry.status === 'failed') && entry.result).at(-1)?.result
      let id = completed ? record(completed.dispatch).id ?? completed.dispatchId ?? completed.dispatch_id ?? record(completed.worker).id ?? record(completed.launch).dispatchId : undefined
      if (typeof id !== 'string') {
        const listed = await this.call(['orchestration', 'worker-list', '--run', run.runId])
        const candidates = Array.isArray(listed.workers) ? listed.workers.map(record).filter(worker => worker.taskId === task.taskId && typeof worker.dispatchId === 'string' && !known.has(worker.dispatchId)) : []
        if (candidates.length === 1) id = candidates[0].dispatchId
      }
      if (typeof id !== 'string') throw new Error('Native startup receipt remains unknown; no replacement was started')
      const shown = await this.call(['orchestration', 'worker-show', '--dispatch', id, '--full'])
      const dispatch = record(shown.dispatch), worker = record(shown.worker)
      if (dispatch.id !== id || (dispatch.taskId ?? dispatch.task_id) !== task.taskId || dispatch.runId !== run.runId || (dispatch.retryOfDispatchId ?? undefined) !== expectedRetry) throw new Error('Native startup receipt identity mismatch')
      const accepted = Array.isArray(worker.effects) && worker.effects.some(effect => record(effect).kind === 'dispatch_input' && record(effect).state === 'accepted')
      if (accepted) {
        if (!known.has(id)) task.attempts.push({ dispatchId: id, agent: task.agent, status: 'running', startedAt: typeof dispatch.dispatchedAt === 'string' ? dispatch.dispatchedAt : new Date().toISOString() })
        task.startup = undefined; task.status = 'running'; task.unconfirmedStart = undefined; task.retryRequested = undefined; task.error = undefined; task.waitReason = undefined; task.activityObservedAt = undefined
      } else if (['failed', 'abandoned', 'stopped'].includes(String(worker.state))) {
        task.startup = { dispatchId: id, ...(typeof worker.agentTerminalHandle === 'string' ? { terminalHandle: worker.agentTerminalHandle } : {}), stage: typeof worker.stage === 'string' ? worker.stage : undefined }
        task.status = 'failed'; task.unconfirmedStart = undefined; task.error = 'Native startup failed before task input was accepted'
      } else throw new Error('Native worker has not confirmed task input; startup remains unresolved')
    }
  }

  async createPipelineWorkspace(source: Workspace, name: string): Promise<Workspace> {
    if (source.hostId && source.hostId !== 'local') throw new Error('Отдельный Pipeline workspace пока доступен для локального Git-проекта. Выберите локальный проект или отключите отдельный workspace.')
    const shown = await this.call(['worktree', 'show', '--worktree', workspaceSelector(source)])
    const parent = record(shown.worktree)
    const repoId = parent.repoId
    const head = parent.head ?? record(parent.git).head
    if (typeof repoId !== 'string' || typeof head !== 'string') throw new Error('Нужен Git workspace для создания Pipeline. Для обычной папки отключите отдельный workspace.')
    const result = await this.call([
      'worktree', 'create', '--repo', `id:${repoId}`, '--name', `pipeline-${name}-${randomUUID().slice(0, 8)}`,
      '--parent-worktree', workspaceSelector(source), '--base-branch', head, '--setup', 'skip'
    ], 180_000)
    const workspace = record(result.worktree)
    if (typeof workspace.id !== 'string' || typeof workspace.path !== 'string') throw new Error('Orca не вернула созданный workspace; проверьте левое меню перед повторным запуском.')
    return { id: workspace.id, kind: 'worktree', path: workspace.path, name: typeof workspace.displayName === 'string' ? workspace.displayName : `Pipeline: ${name}`, branch: typeof workspace.branch === 'string' ? workspace.branch : null, hostId: null }
  }

  async failedStartup(runId: string, taskId: string): Promise<{ dispatchId: string; terminalHandle?: string; stage?: string } | undefined> {
    const result = await this.call(['orchestration', 'worker-list', '--run', runId])
    const workers = Array.isArray(result.workers) ? result.workers.map(record).filter(worker => worker.taskId === taskId) : []
    const worker = workers[0]
    if (!worker) return undefined
    if (!['failed', 'abandoned', 'stopped'].includes(String(worker.workerState)) || typeof worker.dispatchId !== 'string') throw new Error('У шага уже есть незавершённый или непроверенный запуск. Откройте его окно перед повтором.')
    return { dispatchId: worker.dispatchId, ...(typeof worker.agentTerminalHandle === 'string' ? { terminalHandle: worker.agentTerminalHandle } : {}) }
  }

  async openWorker(dispatchId: string, environment = 'local'): Promise<void> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId, '--full'])
    const handle = record(result.worker).agentTerminalHandle ?? record(result.dispatch).assigneeHandle
    if (typeof handle !== 'string' || handle.startsWith('structworker_')) throw new Error('Этот запуск создан фоновым агентом Orca. Его вывод доступен в истории попыток; новые локальные запуски открывают видимые окна.')
    await this.call(['terminal', 'switch', '--terminal', handle, ...(environment !== 'local' ? ['--environment', environment] : [])])
  }

  async createRun(objective: string, coordinatorHandle: string): Promise<string> {
    const result = await this.mutate(['orchestration', 'run-create', '--objective', objective, '--from', coordinatorHandle])
    const id = record(result.run).id
    if (typeof id !== 'string') throw new Error('Orca не вернула Run ID')
    return id
  }

  async bindRun(runId: string, coordinatorHandle: string): Promise<void> {
    await this.mutate(['orchestration', 'run-use', '--id', runId, '--from', coordinatorHandle])
  }

  reviseTask(run: PipelineRun, step: ScenarioStep, revision: number, spec: string, dependencies: string[]): Promise<string> {
    const requestId = operationUuid(`revision:${run.runId}:${step.id}:${revision}`)
    return this.createTask(run.runId, run.coordinatorHandle, step, spec, dependencies, requestId)
  }

  prepareRetry(run: PipelineRun, step: ScenarioStep, task: PipelineTask): Promise<string | undefined> {
    const previous = task.attempts.at(-1)
    if (!previous || !['review', 'acceptance', 'validation'].includes(previous.failure?.phase ?? '') || previous.taskId !== task.taskId) return Promise.resolve(undefined)
    const requestId = operationUuid('after:' + previous.dispatchId)
    return this.createTask(run.runId, run.coordinatorHandle, step, taskSpec(step, undefined, run.runId, true, run.workspacePath), run.scenario.version === 2 ? [] : step.needs.map(id => run.tasks[id].taskId), requestId)
  }

  async createTask(runId: string, coordinatorHandle: string, step: ScenarioStep, spec: string, dependencies: string[], requestId?: string): Promise<string> {
    requestId ??= operationUuid('task:' + runId + ':' + step.id)
    const result = await this.mutate([
      'orchestration', 'task-create', '--run', runId, '--from', coordinatorHandle,
      '--task-title', step.title, '--display-name', step.title,
      '--spec', spec, '--deps', JSON.stringify(dependencies)
    ], undefined, requestId)
    const id = record(result.task).id
    if (typeof id !== 'string') throw new Error(`Orca не вернула Task ID для ${step.id}`)
    return id
  }

  async createGate(runId: string, coordinatorHandle: string, taskId: string, question: string, requestId?: string): Promise<string> {
    const result = await this.mutate([
      'orchestration', 'gate-create', '--task', taskId, '--question', question,
      '--options', JSON.stringify(['approve', 'reject']), '--from', coordinatorHandle
    ], undefined, requestId)
    const id = record(result.gate).id ?? result.id
    if (typeof id !== 'string') throw new Error(`Orca не вернула Gate ID для ${taskId}`)
    return id
  }

  async listGates(runId: string, taskId: string): Promise<Record<string, unknown>[]> {
    const result = await this.call(['orchestration', 'gate-list', '--run', runId, '--task', taskId])
    return Array.isArray(result.gates) ? result.gates.map(record) : []
  }

  async resolveGate(gateId: string, coordinatorHandle: string, resolution: 'approve' | 'reject'): Promise<void> {
    await this.mutate(['orchestration', 'gate-resolve', '--id', gateId, '--resolution', resolution, '--from', coordinatorHandle])
  }

  async listTasks(runId: string): Promise<Record<string, unknown>[]> {
    const result = await this.call(['orchestration', 'task-list', '--run', runId, '--full'])
    return Array.isArray(result.tasks) ? result.tasks.map(record) : []
  }

  async skipTask(runId: string, owner: string, taskId: string, reason: string, requestId?: string): Promise<void> {
    await this.mutate(['orchestration', 'task-update', '--run', runId, '--from', owner, '--id', taskId, '--status', 'blocked',
      '--result', JSON.stringify({ provenance: 'pipeline_condition', outcome: 'skipped', reason })], undefined, requestId)
  }

  async prepareCheckpoint(run: PipelineRun, step: ScenarioStep, taskId: string, body: string): Promise<void> {
    if (step.placement.host !== 'local' || step.placement.worktree !== 'current') throw new Error('Durable checkpoint transfer currently requires local/current placement; no replacement was started')
    const native = (await this.listTasks(run.runId)).find(task => task.id === taskId)
    const path = checkpointFile(run.runId, step.id)
    if (typeof native?.spec !== 'string' || !native.spec.includes(path)) throw new Error('Native Task predates durable file checkpoints. Start a new run from the same YAML; no replacement was started.')
    await new ArtifactStore(run.workspacePath).saveCheckpoint(run, step.id, body)
  }

  async preflight(step: ScenarioStep): Promise<void> {
    if (step.placement.host === 'local') return
    const environment = step.placement.host
    const status = await this.call(['status', '--environment', environment])
    const runtime = record(status.runtime)
    if (runtime.state !== 'ready') throw new Error(`Remote ${environment} не готов: ${String(runtime.state ?? 'unknown')}`)
    const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : []
    if ((step.model || step.effort) && !capabilities.includes('orchestration.worker-launch-preferences.v1')) {
      throw new Error(`Remote ${environment} не поддерживает model/effort для orchestration`)
    }
    if (step.placement.worktree === 'new-child' || step.placement.worktree === 'new-top-level') {
      await this.call(['repo', 'show', '--repo', step.placement.repo!, '--environment', environment])
    } else {
      await this.call(['worktree', 'show', '--worktree', step.placement.worktree, '--environment', environment])
    }
  }

  async startWorker(
    run: { runId: string; coordinatorHandle: string; workspacePath: string; workspaceSelector?: string; visibleWorkers?: boolean; focusWorker?: boolean; tasks?: PipelineRun['tasks'] },
    step: ScenarioStep, taskId: string, agent: string, retryOf?: string, reuseTerminal?: string, requestId?: string
  ): Promise<string> {
    try { return await this.startWorkerImpl(run, step, taskId, agent, retryOf, reuseTerminal, requestId) }
    catch (error) {
      const receipt = record(record(record(error).details).result)
      if (error instanceof Error && record(error).startOutcome !== 'rejected' && receipt.state !== 'failed') Object.assign(error, { startOutcome: 'unknown' })
      throw error
    }
  }

  private async startWorkerImpl(
    run: { runId: string; coordinatorHandle: string; workspacePath: string; workspaceSelector?: string; visibleWorkers?: boolean; focusWorker?: boolean; tasks?: PipelineRun['tasks'] },
    step: ScenarioStep,
    taskId: string,
    agent: string,
    retryOf?: string,
    reuseTerminal?: string,
    requestId?: string
  ): Promise<string> {
    await this.preflight(step)
    if (Object.values(run.tasks ?? {}).some(task => task.taskId === taskId && task.retryRequested)) {
      const task = (await this.listTasks(run.runId)).find(task => task.id === taskId)
      let result = record(task?.result)
      if (typeof task?.result === 'string') { try { result = record(JSON.parse(task.result)) } catch {} }
      if (task?.status === 'blocked' && result.provenance === 'pipeline_condition' && result.outcome === 'skipped') {
        await this.mutate(['orchestration', 'task-update', '--run', run.runId, '--from', run.coordinatorHandle, '--id', taskId, '--status', 'ready', '--result', JSON.stringify({ provenance: 'pipeline_condition', outcome: 'reopened', reason: 'Explicit retry re-evaluated the predecessor results' })])
      }
    }
    const worktree = step.placement.worktree === 'current' ? run.workspaceSelector ?? `path:${run.workspacePath}` : step.placement.worktree
    let terminal: string | undefined = reuseTerminal
    const visible = run.visibleWorkers && step.placement.host === 'local' && !['new-child', 'new-top-level'].includes(worktree)
    if (reuseTerminal) {
      const shown = record((await this.call(['terminal', 'show', '--terminal', reuseTerminal])).terminal)
      if (shown.agentIdentity !== agent || shown.connected !== true || shown.writable !== true) throw Object.assign(new Error('Исходное окно агента изменилось или недоступно. Повторный запуск не отправлен.'), { startOutcome: 'rejected' })
      if (record(shown.agentWait).reason) throw Object.assign(new Error(`Сначала закройте меню в окне агента: ${String(record(shown.agentWait).reason)}`), { startOutcome: 'rejected' })
    }
    if (visible && !terminal) {
      const targetPath = step.placement.worktree === 'current' ? run.workspacePath : record((await this.call(['worktree', 'show', '--worktree', worktree])).worktree).path
      if (typeof targetPath !== 'string') throw new Error('Target worktree path is unconfirmed; no visible agent was launched')
      const launchArgs = ['agent', 'launch', '--agent', agent, '--worktree', worktree, '--surface', 'terminal']
      if (run.focusWorker) launchArgs.push('--focus')
      if (step.model) launchArgs.push('--model', step.model)
      if (step.effort) launchArgs.push('--effort', step.effort)
      const launchId = visibleLaunchId(run.runId, taskId, retryOf, agent)
      const entry: MutationRecord = { requestId: launchId, args: launchArgs, status: 'pending', launch: { runId: run.runId, taskId, retryOf } }
      const prior = await this.mutationReceipt(launchId)
      if (prior && JSON.stringify(prior.args) !== JSON.stringify(launchArgs)) throw new Error('Visible agent launch identity was reused with different arguments')
      if (prior?.status === 'pending') throw new Error('Visible agent launch receipt is unconfirmed; inspect the existing window. No second agent was launched.')
      let owned = record(prior?.result?.pipelineOwnedTerminal) as Partial<OwnedTerminal>
      if (!prior) {
        await this.journal.put(entry)
        let launched: Record<string, unknown>
        try { launched = await this.call(launchArgs, 180_000) }
        catch (error) {
          await this.journal.put({ ...entry, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
        await this.journal.put({ ...entry, result: launched })
        const outcome = record(launched.outcome ?? record(launched.launch).outcome)
        const handle = outcome.handle ?? launched.agentTerminalHandle ?? launched.terminalHandle
        if (typeof handle !== 'string') throw new Error('Orca не вернула handle видимого агента; проверьте workspace перед повторной попыткой.')
        let shown = record((await this.call(['terminal', 'show', '--terminal', handle])).terminal)
        if (shown.handle === handle && typeof shown.incarnationId === 'string') await this.journal.put({ ...entry, result: { ...launched, pipelineLaunchTerminal: { handle, incarnationId: shown.incarnationId, worktreeId: shown.worktreeId, worktreePath: shown.worktreePath } } })
        for (let attempt = 0; shown.agentIdentity !== agent && attempt < 300; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          shown = record((await this.call(['terminal', 'show', '--terminal', handle])).terminal)
        }
        if (shown.handle !== handle || typeof shown.incarnationId !== 'string' || typeof shown.worktreeId !== 'string' || shown.worktreePath !== targetPath || shown.agentIdentity !== agent || shown.connected !== true || shown.writable !== true) throw new Error('Visible terminal ownership and agent readiness were not confirmed; no task input was sent')
        await this.call(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '30000'], 35_000)
        owned = { handle, incarnationId: shown.incarnationId, worktreeId: shown.worktreeId, worktreePath: shown.worktreePath, runId: run.runId, taskId, agent }
        await this.journal.put({ ...entry, status: 'completed', result: { ...launched, pipelineOwnedTerminal: owned } })
      }
      if (typeof owned.handle !== 'string' || typeof owned.incarnationId !== 'string') throw new Error('Visible terminal receipt is incomplete; no task input was sent')
      terminal = owned.handle
      await this.call(['terminal', 'rename', '--terminal', terminal, '--title', `${step.title} · ${agent}`]).catch(() => undefined)
    }
    const args = [
      'orchestration', 'worker-start', '--run', run.runId, '--from', run.coordinatorHandle,
      '--task', taskId, ...(terminal ? ['--terminal', terminal] : ['--agent', agent]), '--worktree', worktree
    ]
    if (step.placement.host !== 'local') args.push('--on', step.placement.host)
    if (step.placement.repo) args.push('--repo', step.placement.repo)
    if (step.placement.name) args.push('--name', step.placement.name)
    if (step.placement.setup) args.push('--setup', step.placement.setup)
    if (run.visibleWorkers) args.push('--keep-open')
    if (!terminal && step.model) args.push('--model', step.model)
    if (!terminal && step.effort) args.push('--effort', step.effort)
    if (retryOf) args.push('--retry-of', retryOf)
    let result: Record<string, unknown>
    try { result = await this.mutate(args, 180_000, requestId) } catch (error) {
      if (error instanceof Error) Object.assign(error, { launchedTerminal: terminal })
      if (error instanceof Error && 'details' in error && error.message.startsWith(`Task ${taskId} is blocked; only a ready Task can start.`)) Object.assign(error, { startOutcome: 'rejected' })
      throw error
    }
    const dispatch = record(result.dispatch)
    const launch = record(result.launch)
    const id = dispatch.id ?? result.dispatchId ?? result.dispatch_id ?? record(result.worker).id ?? launch.dispatchId
    if (typeof id !== 'string') throw new Error(`Orca не вернула Dispatch ID для ${step.id}: ${JSON.stringify(result).slice(0, 500)}`)
    return id
  }

  async workerOutput(dispatchId: string): Promise<string> {
    const result = await this.call(['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'auto', '--limit', '120'])
    return extractText(result).slice(-24_000)
  }

  async workerQuestions(dispatchId: string, runId: string): Promise<WorkerQuestion[]> {
    // Read-only history: never consume the coordinator's mailbox.
    const [inbox, workerInbox] = await Promise.all([
      this.call(['orchestration', 'inbox', '--terminal', `run:${runId}`, '--limit', '500', '--full']),
      this.call(['orchestration', 'inbox', '--terminal', `dispatch:${dispatchId}`, '--limit', '500', '--full'])
    ])
    const answers = Array.isArray(workerInbox.messages) ? workerInbox.messages.map(record) : []
    const messages = Array.isArray(inbox.messages) ? inbox.messages.map(record) : []
    return messages.filter(message => {
      const detail = typeof message.payload === 'string' ? (() => { try { return record(JSON.parse(message.payload)) } catch { return {} } })() : record(message.payload)
      return message.type === 'question' && message.run_id === runId && detail.dispatchId === dispatchId
    }).flatMap(message => {
      if (typeof message.id !== 'string' || typeof message.body !== 'string') return []
      const answered = answers.some(reply => ['reply', 'status'].includes(String(reply.type)) && reply.thread_id === message.id && reply.from_handle === `run:${runId}` && reply.to_handle === `dispatch:${dispatchId}`)
      return [{ id: message.id, question: message.body, state: answered ? 'answered' as const : 'waiting' as const, askedAt: String(message.created_at ?? '') }]
    })
  }

  async answerQuestion(run: PipelineRun, stepId: string, message: UserMessage): Promise<MessageReceipt> {
    const attempt = run.tasks[stepId]?.attempts.at(-1)
    if (!attempt || attempt.status !== 'running' || !message.questionId || !message.text.trim()) throw new Error('Выберите открытый вопрос активного агента и введите ответ')
    const questions = await this.workerQuestions(attempt.dispatchId, run.runId)
    const question = questions.find(question => question.id === message.questionId)
    if (!question) throw new Error('Вопрос не принадлежит текущей попытке этого шага')
    const requestId = operationUuid(`answer:${run.runId}:${attempt.dispatchId}:${message.id}`)
    const prior = await this.mutationReceipt(requestId)
    if (prior && prior.args[prior.args.indexOf('--body') + 1] !== message.text) throw new Error('Для изменённого ответа нужен новый message ID')
    if (question.state !== 'waiting' && !prior) throw new Error('На этот вопрос уже ответили; новый ответ не отправлен')
    await this.mutate(['orchestration', 'reply', '--id', question.id, '--run', run.runId, '--from', run.coordinatorHandle, '--body', message.text], undefined, requestId)
    return { id: message.id, questionId: question.id, state: 'delivered', at: new Date().toISOString() }
  }

  async workerObservation(dispatchId: string): Promise<{ activity: string; waitReason?: string; workerState?: string; questions?: WorkerQuestion[]; interaction?: 'native' }> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId, '--full'])
    const activity = record(record(result.projection).stage).activity
    const waitReason = record(record(result.observation).agentWait).reason
    const runId = record(result.dispatch).runId
    const questions = typeof runId === 'string' ? await this.workerQuestions(dispatchId, runId) : undefined
    return { workerState: typeof record(result.worker).state === 'string' ? record(result.worker).state as string : undefined, activity: questions?.some(question => question.state === 'waiting') ? 'waiting-user' : typeof activity === 'string' ? activity : 'unknown', ...(typeof waitReason === 'string' ? { waitReason } : {}), ...(questions ? { questions, interaction: 'native' as const } : {}) }
  }

  async workerActivityDone(dispatchId: string): Promise<boolean> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId, '--full'])
    const projection = record(result.projection)
    const stage = record(projection.stage)
    const observation = record(result.observation)
    const status = record(result.dispatch).status ?? stage.dispatch
    if (typeof status === 'string' && !['dispatched', 'running'].includes(status)) return false
    return stage.activity === 'done' || observation.status === 'exited'
  }

  async sendWorker(dispatchId: string, subject: string, body: string, coordinatorHandle: string): Promise<void> {
    await this.mutate([
      'orchestration', 'send', '--from', coordinatorHandle, '--to', `dispatch:${dispatchId}`,
      '--subject', subject, '--body', body
    ])
  }

  async stopWorker(dispatchId: string): Promise<void> {
    try { await this.mutate(['orchestration', 'worker-stop', '--dispatch', dispatchId]); return }
    catch (error) {
      const shown = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId, '--full'])
      const worker = record(shown.worker), dispatch = record(shown.dispatch)
      const handle = worker.agentTerminalHandle ?? dispatch.assigneeHandle
      const owner = (await this.journal.list()).map(entry => record(entry.result?.pipelineOwnedTerminal)).find(owner => owner.handle === handle && owner.runId === dispatch.runId && owner.taskId === (dispatch.taskId ?? dispatch.task_id)) as OwnedTerminal | undefined
      // Native --terminal treats a pre-launched CLI as external. Only its creator
      // may close it, and only the exact persisted PTY generation, never by title.
      if (!owner || worker.state !== 'stop_unknown') throw error
      const closeId = 'pipeline-close-' + createHash('sha256').update(owner.handle + ':' + owner.incarnationId).digest('hex').slice(0, 32)
      const prior = await this.mutationReceipt(closeId)
      if (prior?.status === 'pending') throw new Error('Terminal close outcome is unconfirmed; no process exit was claimed')
      if (!prior) {
        const terminal = record((await this.call(['terminal', 'show', '--terminal', owner.handle])).terminal)
        if (terminal.incarnationId !== owner.incarnationId || terminal.worktreeId !== owner.worktreeId || terminal.worktreePath !== owner.worktreePath || (terminal.agentIdentity && terminal.agentIdentity !== owner.agent)) throw new Error('Owned terminal identity changed; cancellation remains unconfirmed')
        const args = ['terminal', 'close', '--terminal', owner.handle]
        await this.journal.put({ requestId: closeId, args, status: 'pending' })
        const closed = await this.call(args)
        const close = record(closed.close)
        if (close.handle !== owner.handle || close.ptyKilled !== true) throw new Error('Terminal close did not confirm PTY termination; cancellation remains unconfirmed')
        await this.journal.put({ requestId: closeId, args, status: 'completed', result: { ...closed, pipelineOwnedTerminal: owner, processStopped: true } })
      } else if (prior.result?.processStopped !== true) throw new Error('Terminal stop receipt is incomplete')
      await this.abandonWorker(dispatchId)
    }
  }

  async abandonWorker(dispatchId: string): Promise<void> {
    await this.mutate(['orchestration', 'worker-abandon', '--dispatch', dispatchId], undefined, operationUuid('abandon:' + dispatchId))
  }

  async releaseWorker(dispatchId: string): Promise<void> {
    await this.mutate(['orchestration', 'worker-release', '--dispatch', dispatchId])
  }
}

function recordResult(error: unknown): Record<string, unknown> {
  return record(record(record(error).details).result)
}

function recordRequest(value: Record<string, unknown>): Record<string, unknown> {
  return record(value.request)
}

function recordReceipt(value: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  return record(value.receipt ?? value.result ?? request.receipt ?? value)
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const root = record(value)
  for (const key of ['content', 'text', 'output', 'message', 'summary', 'result', 'transcript', 'messages', 'blocks', 'terminal', 'tail']) {
    if (root[key] !== undefined) {
      const text = extractText(root[key])
      if (text) return text
    }
  }
  const rows = root.rows ?? root.entries ?? root.records ?? root.lines
  return rows === undefined ? '' : extractText(rows)
}
