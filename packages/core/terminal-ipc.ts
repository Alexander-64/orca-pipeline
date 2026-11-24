import { createConnection } from 'node:net'
import { realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const runtimeProtocol = 4
export class IncompatibleRuntimeError extends Error {}
export type Request = { id: string; command: string; protocol?: number; runId?: string; stepId?: string; agent?: string; source?: string; resolution?: 'approve' | 'reject'; after?: number; backend?: 'local' | 'orca'; text?: string; questionId?: string; messageId?: string }
export const socketPath = (project: string) => join(tmpdir(), `pipeline-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(project).digest('hex').slice(0, 20)}.sock`)

export async function request(project: string, message: Request, timeoutMs = 20_000): Promise<unknown> {
  project = await realpath(project)
  const ping = message.command === 'ping' ? message : { id: randomUUID(), command: 'ping' }
  const hello = await rawRequest(project, { ...ping, protocol: runtimeProtocol }, timeoutMs) as { version?: number }
  if (hello?.version !== runtimeProtocol) throw new IncompatibleRuntimeError(`Incompatible supervisor protocol ${hello?.version ?? 'unknown'}; expected ${runtimeProtocol}. Stop or detach active work using the installed version, then restart the supervisor with the updated pipeline. No action was sent.`)
  return message.command === 'ping' ? hello : rawRequest(project, { ...message, protocol: runtimeProtocol }, timeoutMs)
}

async function rawRequest(project: string, message: Request, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(project))
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Supervisor response timeout; request outcome may be unknown. Reuse the same request ID.')) }, timeoutMs)
    socket.on('error', error => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > 8_000_000) { socket.destroy(); clearTimeout(timer); reject(new Error('Oversized supervisor response')); return }
      if (!buffer.includes('\n')) return
      clearTimeout(timer); socket.end()
      try { const result = JSON.parse(buffer.split('\n')[0]); if (!result.ok) reject(new Error(result.error)); else resolve(result.result) }
      catch (error) { reject(error) }
    })
    socket.on('end', () => { if (!buffer.includes('\n')) { clearTimeout(timer); reject(new Error('Supervisor disconnected before receipt')) } })
  })
}

