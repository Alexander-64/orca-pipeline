import { realpathSync } from 'node:fs'
import { readFile, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCommand, type CheckResult } from './acceptance'
import { atomicJson } from './files'
import type { CommandPolicy, FailureInfo } from '../core/types'
import { redactSecrets } from '../core/failover'
import { currentBootId } from './process-lifetime'

export type ChecksRequest = { version: 1; id: string; runId: string; taskId: string; token: string; cwd: string; commands: string[]; policy?: CommandPolicy; timeoutMs?: number }
export type ChecksResult = { version: 1; id: string; runId: string; taskId: string; outcome: 'succeeded' | 'failed' | 'cancelled'; checks: CheckResult[]; finishedAt: string; failure?: FailureInfo }
export type CommandIntent = { id: string; index: number; command: string; at: string }

export async function checksActor(path: string): Promise<void> {
  const request: ChecksRequest = JSON.parse(await readFile(path, 'utf8'))
  if (request.version !== 1 || !request.id || !Array.isArray(request.commands)) throw new Error('Invalid acceptance request')
  const directory = dirname(path)
  const ownerFile = join(directory, 'owner-' + randomUUID() + '.json')
  await atomicJson(ownerFile, { id: request.id, pid: process.pid, bootId: currentBootId() })
  try { await link(ownerFile, join(directory, 'execution.lock')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error }
  finally { await unlink(ownerFile) }
  await atomicJson(join(directory, 'started.json'), { id: request.id, pid: process.pid, bootId: currentBootId(), at: new Date().toISOString() })
  const abort = new AbortController()
  let checking = false
  const readCancel = async () => {
    if (checking) return
    checking = true
    try {
      const cancel = JSON.parse(await readFile(join(directory, 'cancel.json'), 'utf8'))
      if (cancel.id === request.id && cancel.token === request.token) abort.abort()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') abort.abort() }
    finally { checking = false }
  }
  const timer = setInterval(() => void readCancel(), 100)
  const stop = () => abort.abort()
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  const checks: CheckResult[] = []
  let outcome: ChecksResult['outcome'] = 'succeeded', failure: FailureInfo | undefined
  try {
    for (const [index, command] of request.commands.entries()) {
      await readCancel()
      if (abort.signal.aborted) { outcome = 'cancelled'; break }
      const intent: CommandIntent = { id: request.id, index, command, at: new Date().toISOString() }
      await atomicJson(join(directory, `command-${index}.intent.json`), intent)
      await atomicJson(join(directory, 'progress.json'), { id: request.id, checks, activeIndex: index, command })
      let check: CheckResult
      try {
        check = await checkCommand(command, request.cwd, request.policy, abort.signal, request.timeoutMs, {
          spawned: pid => atomicJson(join(directory, `command-${index}.child.json`), { id: request.id, index, pid, bootId: currentBootId(), actorPid: process.pid, at: new Date().toISOString() })
        })
      } catch (error) { check = { command, exitCode: null, output: '', error: redactSecrets(error instanceof Error ? error.message : String(error)) } }
      checks.push(check)
      await atomicJson(join(directory, `command-${index}.result.json`), { id: request.id, index, check, finishedAt: new Date().toISOString() })
      await atomicJson(join(directory, 'progress.json'), { id: request.id, checks })
      if (abort.signal.aborted) { outcome = 'cancelled'; break }
      if (check.exitCode !== 0) { outcome = 'failed'; break }
    }
    if (abort.signal.aborted) outcome = 'cancelled'
    if (outcome !== 'succeeded') failure = { version: 1, phase: outcome === 'cancelled' ? 'cancellation' : 'acceptance', kind: 'unknown', message: outcome === 'cancelled' ? 'Acceptance cancelled' : 'Acceptance command failed: ' + checks.at(-1)?.command }
    await atomicJson(join(directory, 'result.json'), { version: 1, id: request.id, runId: request.runId, taskId: request.taskId, outcome, checks, failure, finishedAt: new Date().toISOString() } satisfies ChecksResult)
  } finally { clearInterval(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop) }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) void checksActor(process.argv[2]).catch(error => { console.error(redactSecrets(error.message)); process.exitCode = 1 })
