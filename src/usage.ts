import { spawn } from 'node:child_process'
import type { UsageReader, UsageWindow } from './quota'

export function mapCodexRateLimits(value: unknown, observedAt = Date.now()): UsageWindow[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : root
  const rateLimits = result.rateLimits && typeof result.rateLimits === 'object'
    ? result.rateLimits as Record<string, unknown>
    : result
  return ['primary', 'secondary'].flatMap((id) => {
    const window = rateLimits[id]
    if (!window || typeof window !== 'object') return []
    const raw = window as Record<string, unknown>
    if (typeof raw.usedPercent !== 'number') return []
    return [{
      id,
      usedPercent: raw.usedPercent,
      resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : undefined,
      observedAt
    }]
  })
}

export class CodexUsageReader implements UsageReader {
  async read(agent: string): Promise<UsageWindow[]> {
    if (agent !== 'codex') return []
    return this.readCodex()
  }

  private readCodex(): Promise<UsageWindow[]> {
    return new Promise((resolve) => {
      const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve([])
      }, 3_000)
      const finish = (windows: UsageWindow[]) => {
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve(windows)
      }
      child.on('error', () => finish([]))
      child.stdin.on('error', () => finish([]))
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line) as Record<string, unknown>
            if (message.id === 1) {
              child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
              child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`)
            } else if (message.id === 2) {
              finish(mapCodexRateLimits(message))
            }
          } catch {
            continue
          }
        }
      })
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'agent-pipeline', version: '0.1.0' } }
      })}\n`)
    })
  }
}
