import { spawn } from 'node:child_process'
import { validateCommand } from '../core/commands'
import { redactSecrets } from '../core/failover'
import type { CommandPolicy } from '../core/types'

// Commands are argv, never shell programs. Pipelines/expansion require a future explicit capability.
export function commandArgs(command: string): string[] {
  if (/[;&|<>$`\n\r\0]/.test(command)) throw new Error('Shell operators and expansion are not supported in acceptance commands')
  const result: string[] = []
  let token = '', quote = '', escaped = false, started = false
  for (const c of command.trim()) {
    if (escaped) { token += c; escaped = false; started = true; continue }
    if (c === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (c === quote) quote = ''; else token += c; started = true; continue }
    if (c === '"' || c === "'") { quote = c; started = true; continue }
    if (/\s/.test(c)) { if (started) { result.push(token); token = ''; started = false }; continue }
    token += c; started = true
  }
  if (quote || escaped) throw new Error('Unclosed quote or escape in acceptance command')
  if (started) result.push(token)
  if (!result[0]) throw new Error('Empty acceptance command')
  return result
}

export type CheckResult = { command: string; exitCode: number | null; output: string; error?: string }

export function validateLocalCommand(command: string, policy?: CommandPolicy): string[] {
  validateCommand(command, policy)
  const args = commandArgs(command)
  if (policy?.readOnly && !['pwd', 'ls', 'echo'].includes(args[0])) throw new Error('Local read-only acceptance currently supports pwd, ls and echo; use file tools for source inspection')
  if (policy?.readOnly && args[0] === 'pwd' && args.length !== 1) throw new Error('Read-only pwd does not accept arguments')
  return args
}

export async function checkCommand(command: string, cwd: string, policy?: CommandPolicy, signal?: AbortSignal, timeoutMs = 120_000, observe?: { spawned(pid: number): Promise<void> }): Promise<CheckResult> {
  const [executable, ...args] = validateLocalCommand(command, policy)
  if (policy?.readOnly && executable === 'ls') {
    const { realpath } = await import('node:fs/promises')
    const { resolve, relative, sep } = await import('node:path')
    const root = await realpath(cwd)
    for (const arg of args.filter(arg => !arg.startsWith('-'))) {
      const target = await realpath(resolve(root, arg))
      const rel = relative(root, target)
      if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep) || rel.split(sep).some(part => ['.git', '.agent-pipeline', '.orca', '.env'].includes(part))) throw new Error('Read-only acceptance path outside allowed project files')
    }
  }
  return new Promise(resolve => {
    let output = '', failure: string | undefined
    const child = spawn(executable, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    const terminate = () => {
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      else child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { failure = 'Acceptance timeout'; terminate() }, timeoutMs)
    const abort = () => { failure = 'Acceptance cancelled'; terminate() }
    const observed = child.pid && observe ? observe.spawned(child.pid).catch(error => { failure = error instanceof Error ? error.message : String(error); terminate() }) : Promise.resolve()
    signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000) })
    child.on('error', error => { failure = error.message })
    child.on('close', async code => {
      await observed
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      resolve({ command, exitCode: failure ? null : code, output: redactSecrets(output), ...(failure ? { error: failure } : {}) })
    })
  })
}
