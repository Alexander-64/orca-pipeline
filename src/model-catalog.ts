import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import type { AgentModelCatalog } from './types'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// Choose one latest observed snapshot per agent; never union models across account fingerprints.
export function parseModelCatalog(rows: unknown[]): Record<string, AgentModelCatalog> {
  const result: Record<string, AgentModelCatalog> = {}
  for (const value of rows) {
    const row = record(value)
    if (typeof row.agent !== 'string' || !/^[\w.-]+$/.test(row.agent)) continue
    for (const source of ['discovered', 'live']) {
      const snapshot = record(row[source])
      if (!['probe', 'live-session'].includes(String(snapshot.origin)) || !Number.isFinite(snapshot.at) || snapshot.complete === false || !Array.isArray(snapshot.models)) continue
      if ((result[row.agent]?.observedAt ?? -1) >= Number(snapshot.at)) continue
      const models = snapshot.models.flatMap(value => {
        const model = record(value)
        if (typeof model.id !== 'string' || !model.id.trim()) return []
        const efforts = model.effortsKnown === false || !Array.isArray(model.efforts) ? [] : model.efforts.flatMap(value => {
          const effort = record(value)
          return typeof effort.value === 'string' && effort.value.trim() ? [{ value: effort.value, label: typeof effort.label === 'string' ? effort.label : effort.value }] : []
        })
        return [{ id: model.id, label: typeof model.label === 'string' ? model.label : model.id, efforts }]
      })
      result[row.agent] = { observedAt: Number(snapshot.at), models }
    }
  }
  return result
}

export function modelCatalogPath(platform = process.platform, env = process.env): string {
  const profile = env.ORCA_USER_DATA_PATH || env.ORCA_USER_DATA
  if (profile) return join(profile, 'agent-model-catalog.db')
  const base = platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'Orca', 'agent-model-catalog.db')
}

type LaunchCatalog = { supportsWorkerLaunchPreferences?: boolean; models?: { id: string; options?: { id: string; kind: { type: string; choices?: { value: string }[] } }[] }[]; unknownModelOptions?: { id: string; kind: { type: string; choices?: { value: string }[] } }[] }

function launchCatalogReader(): ((agent: string) => LaunchCatalog | undefined) | undefined {
  // Orca's own launch validator is the authority on which observed choices can be applied at startup.
  const resources = process.env.ORCA_CLI_COMMAND ? dirname(dirname(process.env.ORCA_CLI_COMMAND))
    : process.execPath.includes('.app/Contents/') ? process.execPath.split('.app/Contents/')[0] + '.app/Contents/Resources'
      : join(dirname(process.execPath), 'resources')
  const candidates = [
    process.env.ORCA_DEV_REPO_ROOT ? join(process.env.ORCA_DEV_REPO_ROOT, 'out', 'shared', 'agent-session', 'options', 'agent-session-option-catalog.js') : '',
    join(resources, 'app.asar.unpacked', 'out', 'shared', 'agent-session', 'options', 'agent-session-option-catalog.js')
  ]
  for (const file of candidates.filter(Boolean)) {
    if (!existsSync(file)) continue
    try { return createRequire(file)(file).getAgentSessionOptionLaunchCatalog } catch { /* Defaults remain usable on other Orca builds. */ }
  }
  return undefined
}

export function readModelCatalog(file = modelCatalogPath(), reader = launchCatalogReader): {
  modelCatalogs: Record<string, AgentModelCatalog>
  modelCatalogState: 'undiscovered' | 'ready' | 'unsupported'
  unsupportedModelAgents?: string[]
} {
  if (!existsSync(file)) return { modelCatalogs: {}, modelCatalogState: 'undiscovered' }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const parsed = parseModelCatalog(db.prepare('SELECT value FROM rows ORDER BY seq').all().flatMap(row => {
      try { return [JSON.parse(String(row.value))] } catch { return [] }
    }))
    const launchCatalog = reader()
    if (!launchCatalog) return { modelCatalogs: {}, modelCatalogState: 'unsupported' }
    const unsupportedModelAgents: string[] = []
    const modelCatalogs = Object.fromEntries(Object.entries(parsed).flatMap(([agent, snapshot]) => {
      const launch = launchCatalog(agent)
      if (!launch?.supportsWorkerLaunchPreferences) { unsupportedModelAgents.push(agent); return [] }
      return [[agent, { ...snapshot, models: snapshot.models.map(model => {
        const known = launch.models?.find(item => item.id === model.id)
        const option = (known ? known.options : launch.unknownModelOptions)?.find(item => item.id === 'effort')
        const allowed = new Set(option?.kind.type === 'select' ? option.kind.choices?.map(item => item.value) : [])
        return { ...model, efforts: model.efforts.filter(item => allowed.has(item.value)) }
      }) }]]
    }))
    return { modelCatalogs, modelCatalogState: Object.keys(parsed).length ? 'ready' : 'undiscovered', unsupportedModelAgents }
  } catch {
    return { modelCatalogs: {}, modelCatalogState: 'unsupported' }
  } finally { db?.close() }
}
