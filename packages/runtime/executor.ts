import { spawn } from 'node:child_process'
import type { Executor } from './config'
import { redactSecrets, redactValue } from '../core/failover'

export async function runCommandExecutor(executor: Executor, cwd: string, prompt: string, readOnly: boolean, signal: AbortSignal, onEvent: (event: { kind: string; text?: string }) => void): Promise<{ text: string; sessionFile?: string }> {
  if (!['codex', 'jsonl'].includes(executor.kind)) throw new Error('Command executor cannot run ' + executor.kind)
  const codex = executor.kind === 'codex'
  const args = codex
    ? ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--sandbox', readOnly ? 'read-only' : 'workspace-write', ...(executor.model ? ['--model', executor.model] : []), '-']
    : executor.args ?? []
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled before start')); return }
    const child = spawn(executor.executable ?? 'codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    let buffer = '', text = '', completed = false, failure = '', session: string | undefined, killTimer: NodeJS.Timeout | undefined
    let stderr = ''
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return
      try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig) } catch {}
    }
    const cancel = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000) }
    signal.addEventListener('abort', cancel, { once: true })
    const line = (source: string) => {
      let event: Record<string, unknown>
      try { event = JSON.parse(source) } catch { failure = 'Executor stdout is not JSONL'; return }
      if (codex) {
        if (event.type === 'thread.started') session = String(event.thread_id)
        if (event.type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined
          if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text.slice(-200_000)
        }
        if (event.type === 'turn.completed') completed = true
        if (event.type === 'turn.failed' || event.type === 'error') failure = JSON.stringify(event).slice(-8000)
      } else if (event.type === 'result') {
        completed = event.outcome === 'succeeded' && typeof event.text === 'string'
        if (completed) text = String(event.text).slice(-200_000)
        else failure = typeof event.error === 'string' ? event.error : 'Executor reported failure'
      }
      onEvent({ kind: String(event.type ?? 'executor.event'), text: JSON.stringify(redactValue(event)).slice(0, 8000) })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1_000_000) { failure = 'Executor JSONL line too large'; cancel(); return }
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (value.trim()) line(value) }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_000) })
    child.on('error', error => { failure = error.message })
    child.stdin.on('error', error => { if (!failure) failure = error.message })
    child.on('close', code => {
      signal.removeEventListener('abort', cancel); if (killTimer) clearTimeout(killTimer)
      if (buffer.trim()) line(buffer)
      if (stderr) onEvent({ kind: 'executor.stderr', text: redactSecrets(stderr) })
      if (signal.aborted || code !== 0 || failure || !completed || !text.trim()) reject(new Error(redactSecrets(failure || stderr || `Executor did not succeed (exit ${code}, cancelled ${signal.aborted})`)))
      else resolve({ text: redactSecrets(text), sessionFile: session })
    })
    child.stdin.end(prompt)
  })
}
