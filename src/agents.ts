import type { AgentOption } from './types'

export const KNOWN_AGENTS = ['codex', 'claude', 'kimi', 'omp', 'pi', 'grok', 'gemini', 'opencode', 'cursor', 'devin']

export function agentOptions(discovered: AgentOption[] = [], current: string[] = []): { value: string; label: string }[] {
  const options = new Map(KNOWN_AGENTS.map(id => [id, id]))
  for (const agent of discovered) options.set(agent.id, agent.label)
  for (const id of current.filter(Boolean)) if (!options.has(id)) options.set(id, id)
  return [...options].map(([value, label]) => ({ value, label }))
}

export async function discoverAgents(host: () => Promise<unknown>, accounts: () => Promise<unknown>): Promise<AgentOption[]> {
  const merged = new Map<string, AgentOption>(KNOWN_AGENTS.map(id => [id, { id, label: id, source: 'known' }]))
  const results = await Promise.allSettled([host(), accounts()])
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const add = (value: unknown, source: string) => {
    const row = record(value)
    const id = typeof row.agent === 'string' ? row.agent.trim() : ''
    if (!id || !/^[\w.-]+$/.test(id)) return
    merged.set(id, { id, label: id, source, ...(typeof row.state === 'string' ? { status: row.state } : {}) })
  }
  if (results[1].status === 'fulfilled') {
    for (const [id, value] of Object.entries(record(results[1].value))) {
      if (Array.isArray(record(value).accounts)) add({ agent: id }, 'account')
    }
  }
  if (results[0].status === 'fulfilled') {
    const agents = record(results[0].value).agents
    if (Array.isArray(agents)) for (const agent of agents) add(agent, 'workspace')
  }
  return [...merged.values()]
}
