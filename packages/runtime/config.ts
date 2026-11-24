import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Executor = {
  kind: 'pi' | 'codex' | 'jsonl' | 'orca'
  agent?: string
  executable?: string
  args?: string[]
  model?: string
  provider?: string
}
export type RuntimeConfig = {
  backend?: 'local' | 'orca'
  orca?: { executable?: string; workspace?: string; visibleWorkers?: boolean }
  executors: Record<string, Executor>
  planner?: { kind: 'command'; executor: string } | { kind: 'api'; baseUrlEnv: string; apiKeyEnv: string; model: string }
}

export async function loadConfig(project: string): Promise<RuntimeConfig> {
  let raw: unknown
  try { raw = JSON.parse(await readFile(join(project, '.agent-pipeline', 'config.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { executors: { pi: { kind: 'pi' }, codex: { kind: 'codex' } } }
    throw error
  }
  if (!raw || typeof raw !== 'object' || !('executors' in raw)) throw new Error('config.json: executors required')
  const config = raw as RuntimeConfig
  if (config.backend !== undefined && !['local', 'orca'].includes(config.backend)) throw new Error('config.json: backend must be local or orca')
  if (!config.executors || typeof config.executors !== 'object' || Array.isArray(config.executors)) throw new Error('config.json: invalid executors')
  for (const [id, executor] of Object.entries(config.executors)) {
    if (!/^[\w.-]+$/.test(id) || !executor || !['pi', 'codex', 'jsonl', 'orca'].includes(executor.kind)) throw new Error(`config.json: invalid executor ${id}`)
    if (executor.kind === 'orca' && (typeof executor.agent !== 'string' || !/^[\w.-]+$/.test(executor.agent))) throw new Error(`config.json: native agent required for ${id}`)
    if (executor.kind !== 'orca' && executor.agent !== undefined) throw new Error(`config.json: agent is only valid for native Orca executors: ${id}`)
    if (executor.executable !== undefined && (typeof executor.executable !== 'string' || !executor.executable)) throw new Error(`config.json: invalid executable ${id}`)
    if (executor.kind === 'jsonl' && !executor.executable) throw new Error(`config.json: executable required for ${id}`)
    if (executor.args !== undefined && (!Array.isArray(executor.args) || executor.args.some(arg => typeof arg !== 'string'))) throw new Error(`config.json: invalid args ${id}`)
  }
  return config
}
