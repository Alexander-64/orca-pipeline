import { createServer, type Server } from 'node:net'
import { readFile, unlink, chmod, mkdir, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { socketPath, runtimeProtocol, type Request } from '../core/terminal-ipc'
export { request, socketPath, type Request } from '../core/terminal-ipc'
import { Coordinator, assertRunVersions } from '../core/coordinator'
import { ArtifactStore } from '../core/artifacts'
import { parseScenario } from '../core/scenario'
import { redactSecrets } from '../core/failover'
import type { PipelineRun } from '../core/types'
import { loadConfig } from './config'
import { createBackend } from './factory'
import { RunStore, type SupervisorOwner } from './store'
import { atomicJson } from './files'
import { currentBootId, processExited } from './process-lifetime'

export const statePath = (project: string) => join(project, '.agent-pipeline', 'runtime', 'state.sqlite')
const fingerprintOf = (message: Request) => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(message).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')

export async function serve(projectPath: string, options: { backend?: typeof createBackend } = {}): Promise<void> {
  const project = await realpath(projectPath)
  const lockPath = join(dirname(statePath(project)), 'supervisor.lock')
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const previous = await readFile(lockPath, 'utf8').then(text => JSON.parse(text) as SupervisorOwner, error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (previous && !processExited(previous.pid, previous.bootId)) throw new Error('Supervisor owner is still alive or its exit is unverified')
  const store = new RunStore(statePath(project))
  try { store.claimSupervisor({ pid: process.pid, token, bootId: currentBootId() }, previous) }
  catch (error) { store.close(); throw error }
  await atomicJson(lockPath, { pid: process.pid, token, bootId: currentBootId() })
  const config = await loadConfig(project)
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const backend = (options.backend ?? createBackend)(store, project, config)
  const coordinator = new Coordinator({
    client: backend, artifacts: new ArtifactStore(project),
    save: async run => store.put('run:' + run.id, run, 'run.changed', { id: run.id, status: run.status }),
    notify: () => {}, log: text => store.event('runtime.log', { text: redactSecrets(text) })
  })
  let closing = false, lastRequest = Date.now(), queue = Promise.resolve()
  let server: Server
  const enqueue = (fn: () => Promise<void>) => { const operation = queue.then(fn); queue = operation.catch(error => store.event('runtime.error', { error: redactSecrets(String(error)) })); return operation }
  const close = async () => {
    if (closing) return
    closing = true; clearInterval(timer)
    await queue
    await new Promise<void>(resolve => server.close(() => resolve()))
    const owner = JSON.parse(await readFile(lockPath, 'utf8'))
    if (owner.token === token) await unlink(lockPath)
    store.releaseSupervisor(token); store.close()
  }
  const handle = async (message: Request): Promise<unknown> => {
    if (!message || typeof message.id !== 'string' || message.id.length > 100 || typeof message.command !== 'string') throw new Error('Invalid request')
    lastRequest = Date.now()
    if (message.command === 'ping') return { pid: process.pid, version: runtimeProtocol, backend: config.backend ?? 'local', configHash }
    if (message.protocol !== runtimeProtocol) throw new Error('Incompatible client protocol; update the client before sending controls')
    if (message.command === 'status') {
      const all = coordinator.list()
      const runs = message.runId ? all.filter(run => run.id === message.runId) : all.slice(0, 100).map(run => ({
        ...run, tasks: Object.fromEntries(Object.entries(run.tasks).map(([id, task]) => [id, { ...task, attempts: task.attempts.map(({ output: _output, ...attempt }) => attempt) }]))
      }))
      return { runs: structuredClone(runs), totalRuns: all.length, truncated: !message.runId && all.length > 100, pendingRequests: store.list<{ id: string; state: string; command?: string }>('request:').filter(item => item.state === 'pending').map(({ id, command }) => ({ id, command })), events: store.events(message.after ?? 0) }
    }
    if (message.command === 'shutdown') {
      if (coordinator.list().some(run => ['running', 'paused'].includes(run.status))) throw new Error('Stop active runs before shutting down the supervisor')
      setTimeout(() => void close(), 50); return { closing: true }
    }
    const fingerprint = fingerprintOf(message)
    const previous = store.get<{ fingerprint: string; state: string; result?: unknown; error?: string }>('request:' + message.id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID was reused with different arguments')
      if (previous.state === 'completed') return previous.result
      if (previous.state === 'failed') throw new Error(previous.error ?? 'Previous request failed')
      throw new Error('Request outcome is unknown; inspect the current run before a new action')
    }
    store.put('request:' + message.id, { id: message.id, command: message.command, fingerprint, state: 'pending' })
    try {
    let result: unknown
    if (message.command === 'run') {
      const currentConfigHash = createHash('sha256').update(JSON.stringify(await loadConfig(project))).digest('hex')
      if (currentConfigHash !== configHash) throw new Error('Configuration changed. Stop active runs, run pipeline shutdown, then start again.')
      if (!message.source) throw new Error('Scenario source required')
      const scenario = parseScenario(message.source)
      if (message.backend !== undefined && !['local', 'orca'].includes(message.backend)) throw new Error('Invalid backend')
      backend.mode = message.backend ?? config.backend ?? 'local'
      const activeRuns = coordinator.list().filter(run => ['running', 'paused'].includes(run.status))
      if (activeRuns.some(run => !run.scenario.commandPolicy?.readOnly) || (!scenario.commandPolicy?.readOnly && activeRuns.length > 0)) throw new Error('Another run owns this checkout. Finish it before starting a writing run.')
      const snapshot = { source: message.source, hash: createHash('sha256').update(message.source).digest('hex'), requestId: message.id }
      store.put('plan-snapshot:' + message.id, snapshot)
      const workspace = { id: 'folder:' + project, kind: 'folder' as const, name: project.split('/').at(-1)!, path: project, branch: null, hostId: null }
      backend.creationRequestId = message.id
      let run: PipelineRun
      try { run = await coordinator.start(workspace, 'local-supervisor', scenario) }
      finally { backend.creationRequestId = undefined }
      run.backend = backend.mode
      store.put('run:' + run.id, run, 'run.changed', { id: run.id, status: run.status, backend: run.backend })
      store.put('snapshot:' + run.id, snapshot)
      result = run
    } else {
      if (!message.runId) throw new Error('runId required')
      const id = message.runId
      const run = coordinator.get(id)
      if (store.get('reconciliation:' + id) && !['reconcile', 'pause'].includes(message.command)) throw new Error('Run reconciliation is incomplete. Use pipeline reconcile --run ID before further actions.')
      switch (message.command) {
        case 'reconcile':
          await backend.reconcile(run)
          store.put('reconciliation:' + id, null)
          run.error = undefined; run.updatedAt = new Date().toISOString(); store.put('run:' + id, run)
          break
        case 'pause': await coordinator.pause(id); break
        case 'resume': await coordinator.resume(id); break
        case 'stop': await coordinator.cancel(id); break
        case 'retry': await coordinator.retry(id); break
        case 'recover': {
          const task = run.tasks[message.stepId ?? '']
          const attempt = task?.attempts.at(-1)
          if (!['running', 'paused'].includes(run.status) || attempt?.status !== 'running') throw new Error('Select an interrupted active Pi attempt')
          await backend.recoverPi(attempt.dispatchId); break
        }
        case 'approve':
          if (!message.stepId || !message.resolution) throw new Error('stepId and resolution required')
          await coordinator.resolveGate(id, message.stepId, message.resolution); break
        case 'assign':
          if (!message.stepId || !message.agent) throw new Error('stepId and agent required')
          await coordinator.assignAgent(id, message.stepId, message.agent); break
        case 'open': {
          const task = run.tasks[message.stepId ?? '']
          const dispatch = task?.startup?.dispatchId ?? task?.attempts.at(-1)?.dispatchId
          if (!dispatch || !('openWorker' in backend)) throw new Error('No native Orca window for this step; use the report view')
          await backend.openWorker(dispatch); break
        }
        case 'send': {
          const task = run.tasks[message.stepId ?? '']
          const attempt = task?.attempts.at(-1)
          if (!attempt || attempt.status !== 'running') throw new Error('Select an active worker; no follow-up task was created')
          if (typeof message.text !== 'string') throw new Error('Message text required')
          const receipt = await backend.sendUserMessage(attempt.dispatchId, { id: message.messageId ?? message.id, text: message.text, questionId: message.questionId })
          result = { receipt, run: coordinator.get(id) }; break
        }
        default: throw new Error('Unsupported command: ' + message.command)
      }
      if (message.command !== 'send') result = coordinator.get(id)
    }
    store.put('request:' + message.id, { fingerprint, state: 'completed', result })
    return result
    } catch (error) {
      store.put('request:' + message.id, { fingerprint, state: 'failed', error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      throw error
    }
  }
  const restored = store.list<PipelineRun>('run:')
  assertRunVersions(restored)
  for (const run of restored) run.backend = store.get<{ backend?: 'local' | 'orca' }>('native-run:' + run.runId)?.backend ?? 'local'
  for (const run of restored) if (run.status === 'running' || run.status === 'paused') {
    try {
      await backend.reconcile(run)
      if (store.get('reconciliation:' + run.id)) {
        store.put('reconciliation:' + run.id, null); run.error = undefined
        store.put('run:' + run.id, run)
      }
    }
    catch (error) {
      run.status = 'paused'; run.error = 'Reconciliation required: ' + redactSecrets(error instanceof Error ? error.message : String(error))
      run.updatedAt = new Date().toISOString()
      store.put('reconciliation:' + run.id, { error: run.error })
      store.put('run:' + run.id, run, 'run.reconciliation-blocked', { id: run.id, error: run.error })
    }
  }
  coordinator.restore(restored)
  // Recovered orphan attempts continue writing their own receipts; no process is respawned.
  const timer = setInterval(() => {
    if (closing) return
    void enqueue(async () => {
      for (const run of coordinator.list()) if ((run.status === 'running' || run.status === 'paused') && !store.get('reconciliation:' + run.id)) await coordinator.tick(run.id)
      if (Date.now() - lastRequest > 60_000 && !coordinator.list().some(run => ['running', 'paused'].includes(run.status))) setTimeout(() => void close(), 0)
    })
  }, 250)
  const socket = socketPath(project)
  await unlink(socket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  server = createServer(connection => {
    let buffer = '', handled = false
    connection.setTimeout(30_000, () => connection.destroy())
    connection.on('error', () => {})
    connection.on('data', chunk => {
      if (handled) return
      buffer += chunk.toString()
      if (buffer.length > 1_000_000) { connection.destroy(); return }
      if (!buffer.includes('\n')) return
      handled = true
      let message: Request
      try { message = JSON.parse(buffer.split('\n')[0]) }
      catch { connection.end(JSON.stringify({ ok: false, error: 'Invalid request JSON' }) + '\n'); return }
      // Cancellation must reach an acceptance actor even while Native startup or
      // another control is waiting in the serialized queue. Guard protocol and
      // scope before making this durable admission-side change.
      const previous = typeof message?.id === 'string' ? store.get<{ fingerprint: string; state: string }>('request:' + message.id) : undefined
      const admissionAllowed = !previous || (previous.fingerprint === fingerprintOf(message) && previous.state === 'pending')
      const target = admissionAllowed && message?.protocol === runtimeProtocol && typeof message.id === 'string' && message.id.length <= 100 && message.command === 'stop'
        ? coordinator.list().find(run => run.id === message.runId && ['running', 'paused', 'failed'].includes(run.status)) : undefined
      let stopError: unknown
      const stopAdmission = target ? backend.requestStop(target).catch(error => { stopError = error }) : Promise.resolve()
      const respond = async () => {
        try { await stopAdmission; if (stopError) throw stopError; const result = await handle(message); connection.end(JSON.stringify({ ok: true, result }) + '\n') }
        catch (error) { connection.end(JSON.stringify({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) }) + '\n') }
      }
      // Read-only observations must remain available while Native launch waits for a receipt.
      if (message.command === 'status' || message.command === 'ping') { void respond(); return }
      const release = ['pause', 'stop'].includes(message.command) && message.runId ? coordinator.deferStarts(message.runId) : () => {}
      void enqueue(async () => { try { await respond() } finally { release() } })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  await chmod(socket, 0o600)
  await atomicJson(join(dirname(lockPath), 'supervisor.json'), { pid: process.pid, socket, version: runtimeProtocol })
  store.event('supervisor.ready', { pid: process.pid, token, bootId: currentBootId() })
  process.once('SIGTERM', () => void close())
  process.once('SIGINT', () => void close())
}
