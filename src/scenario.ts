import { parse, stringify } from '../vendor/yaml/index.js'
import { validateAcceptance } from './commands'
import type { AgentPolicy, Scenario, ScenarioStep } from './types'

const ID = /^[a-z][a-z0-9-]*$/
const WORKSPACES = new Set(['current', 'new-child', 'new-top-level'])

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${path}: expected a non-empty string`)
  return value.trim()
}

function strings(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path}: expected a list of strings`)
  return value.map((item, index) => text(item, `${path}[${index}]`))
}

function positiveInteger(value: unknown, path: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 16) throw new Error(`${path}: expected a value from 1 to 16`)
  return result
}

function limits(value: unknown, path: string): Record<string, number> | undefined {
  if (value === undefined) return undefined
  const raw = object(value, path)
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, positiveInteger(item, `${path}.${key}`)]))
}

function parseRoles(value: unknown): Record<string, AgentPolicy> | undefined {
  if (value === undefined) return undefined
  const raw = object(value, 'roles')
  return Object.fromEntries(Object.entries(raw).map(([role, value]) => {
    const policy = object(value, `roles.${role}`)
    return [role, {
      agent: text(policy.agent, `roles.${role}.agent`),
      fallback: strings(policy.fallback, `roles.${role}.fallback`),
      model: policy.model === undefined ? undefined : text(policy.model, `roles.${role}.model`),
      effort: policy.effort === undefined ? undefined : text(policy.effort, `roles.${role}.effort`)
    }]
  }))
}

function stepFrom(value: unknown, index: number, roles?: Record<string, AgentPolicy>): ScenarioStep {
  const raw = object(value, `steps[${index}]`)
  const id = text(raw.id, `steps[${index}].id`)
  if (!ID.test(id)) throw new Error(`steps[${index}].id: use lowercase letters, digits and hyphens`)
  const placementRaw = raw.placement === undefined ? {} : object(raw.placement, `steps[${index}].placement`)
  const host = placementRaw.host === undefined ? 'local' : text(placementRaw.host, `steps[${index}].placement.host`)
  const worktree = placementRaw.worktree === undefined
    ? 'current'
    : text(placementRaw.worktree, `steps[${index}].placement.worktree`)
  if (host !== 'local' && worktree === 'current') {
    throw new Error(`steps[${index}]: a remote step requires an exact workspace selector or new-top-level`)
  }
  if (host !== 'local' && WORKSPACES.has(worktree) && worktree !== 'current' && placementRaw.repo === undefined) {
    throw new Error(`steps[${index}]: a new remote worktree requires placement.repo`)
  }
  const attempts = raw.maxAttempts === undefined ? 3 : Number(raw.maxAttempts)
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error(`steps[${index}].maxAttempts: expected a value from 1 to 3`)
  }
  const repairs = raw.maxRepairs === undefined ? 2 : Number(raw.maxRepairs)
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > 2) {
    throw new Error(`steps[${index}].maxRepairs: expected a value from 0 to 2`)
  }
  const acceptance = strings(raw.acceptance, `steps[${index}].acceptance`)
  if (acceptance.length === 0) throw new Error(`steps[${index}].acceptance: at least one check is required`)
  const setup = placementRaw.setup === undefined ? undefined : text(placementRaw.setup, `steps[${index}].placement.setup`)
  if (setup && !['run', 'skip', 'inherit'].includes(setup)) throw new Error(`steps[${index}].placement.setup: expected run, skip or inherit`)
  const routingRole = raw.role === undefined ? undefined : text(raw.role, `steps[${index}].role`)
  const policy = routingRole ? roles?.[routingRole] : undefined
  if (routingRole && !policy) throw new Error(`steps[${index}]: unknown role ${routingRole}`)
  const agent = raw.agent ?? policy?.agent
  return {
    id,
    title: text(raw.title, `steps[${index}].title`),
    spec: text(raw.spec, `steps[${index}].spec`),
    needs: strings(raw.needs, `steps[${index}].needs`),
    agent: text(agent, `steps[${index}].agent`),
    fallback: raw.fallback === undefined ? policy?.fallback.filter((candidate) => candidate !== agent) ?? [] : strings(raw.fallback, `steps[${index}].fallback`),
    model: raw.model === undefined ? policy?.model : text(raw.model, `steps[${index}].model`),
    effort: raw.effort === undefined ? policy?.effort : text(raw.effort, `steps[${index}].effort`),
    placement: {
      host,
      worktree,
      repo: placementRaw.repo === undefined ? undefined : text(placementRaw.repo, `steps[${index}].placement.repo`),
      name: placementRaw.name === undefined ? undefined : text(placementRaw.name, `steps[${index}].placement.name`),
      setup: setup as ScenarioStep['placement']['setup']
    },
    acceptance,
    maxAttempts: attempts,
    maxRepairs: repairs,
    reviewAgent: raw.reviewAgent === undefined ? undefined : text(raw.reviewAgent, `steps[${index}].reviewAgent`),
    routingRole,
    routingReason: policy ? `role ${routingRole} → ${agent}` : undefined,
    approval: raw.approval === undefined ? undefined : text(raw.approval, `steps[${index}].approval`)
  }
}

function expandEvidenceGates(steps: ScenarioStep[]): ScenarioStep[] {
  const evidenceIds = new Map<string, string>()
  for (const step of steps) {
    if (!step.reviewAgent) continue
    if (step.reviewAgent === step.agent) throw new Error(`steps.${step.id}: reviewAgent must differ from the implementing agent`)
    const id = `${step.id}-evidence`
    if (steps.some((candidate) => candidate.id === id)) throw new Error(`steps.${step.id}: ${id} already exists`)
    evidenceIds.set(step.id, id)
  }
  const expanded: ScenarioStep[] = []
  for (const step of steps) {
    expanded.push({ ...step, needs: step.needs.map((id) => evidenceIds.get(id) ?? id) })
    if (!step.reviewAgent) continue
    expanded.push({
      ...step,
      id: `${step.id}-evidence`,
      title: `Evidence Gate: ${step.title}`,
      spec: `Independently review “${step.title}”. Inspect the Git diff, rerun all acceptance commands and compare the result with the original task. Do not fix the code yourself. Return SHIP, FIX-FIRST or BLOCKED with concrete evidence.`,
      needs: [step.id],
      agent: step.reviewAgent,
      fallback: step.fallback.filter((agent) => agent !== step.reviewAgent && agent !== step.agent),
      reviewAgent: undefined,
      role: 'evidence',
      gateFor: step.id,
      repairRound: 0
    })
  }
  if (expanded.length > 100) throw new Error('steps: at most 100 steps including Evidence Gates')
  return expanded
}

export function parseScenario(source: string, options: { expandEvidence?: boolean } = {}): Scenario {
  let parsed: unknown
  try {
    parsed = parse(source)
  } catch (error) {
    throw new Error(`YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const raw = object(parsed, 'scenario')
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('steps: at least one step is required')
  if (raw.steps.length > 50) throw new Error('steps: at most 50 steps')
  const roles = parseRoles(raw.roles)
  const steps = options.expandEvidence === false
    ? raw.steps.map((step, index) => stepFrom(step, index, roles))
    : expandEvidenceGates(raw.steps.map((step, index) => stepFrom(step, index, roles)))
  const byId = new Map<string, ScenarioStep>()
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`steps: duplicate id ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of steps) {
    if (new Set([step.agent, ...step.fallback]).size !== step.fallback.length + 1) {
      throw new Error(`steps.${step.id}: fallback agents must be distinct and differ from the primary agent`)
    }
    for (const dependency of step.needs) {
      if (!byId.has(dependency)) throw new Error(`steps.${step.id}: unknown dependency ${dependency}`)
      if (dependency === step.id) throw new Error(`steps.${step.id}: step depends on itself`)
    }
    if (step.effort && !step.model) throw new Error(`steps.${step.id}: effort requires model`)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`steps: dependency cycle through ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.needs) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
  const policyRaw = raw.commandPolicy === undefined ? undefined : object(raw.commandPolicy, 'commandPolicy')
  const commandPolicy = policyRaw ? {
    allowedCommands: policyRaw.allowedCommands === undefined ? undefined : strings(policyRaw.allowedCommands, 'commandPolicy.allowedCommands'),
    readOnly: policyRaw.readOnly === true
  } : undefined
  for (const step of steps) validateAcceptance(step.acceptance, commandPolicy)
  const quotaThreshold = raw.quotaThreshold === undefined ? 95 : Number(raw.quotaThreshold)
  if (!Number.isFinite(quotaThreshold) || quotaThreshold < 1 || quotaThreshold > 100) throw new Error('quotaThreshold: expected a value from 1 to 100')
  const prRaw = raw.pullRequest === undefined ? undefined : object(raw.pullRequest, 'pullRequest')
  if (prRaw?.merge && !prRaw.mergeApproval) throw new Error('pullRequest.mergeApproval is required to merge')
  const pullRequest = prRaw ? {
    base: text(prRaw.base, 'pullRequest.base'),
    merge: prRaw.merge === true,
    mergeApproval: prRaw.mergeApproval === undefined ? undefined : text(prRaw.mergeApproval, 'pullRequest.mergeApproval')
  } : undefined
  return {
    name: text(raw.name, 'name'),
    objective: text(raw.objective, 'objective'),
    steps,
    maxConcurrent: raw.maxConcurrent === undefined ? 3 : positiveInteger(raw.maxConcurrent, 'maxConcurrent'),
    providerLimits: limits(raw.providerLimits, 'providerLimits'),
    hostLimits: limits(raw.hostLimits, 'hostLimits'),
    commandPolicy,
    quotaThreshold,
    roles,
    pullRequest
  }
}

export function serializeScenario(scenario: Scenario): string {
  return stringify(scenario)
}

export function taskSpec(step: ScenarioStep, handoff?: string): string {
  const acceptance = step.acceptance.map((command, index) => `${index + 1}. ${command}`).join('\n')
  const evidence = step.role === 'evidence'
    ? 'Act as an independent reviewer. For SHIP, report worker_done succeeded. For fixable issues, return FIX-FIRST and report worker_done failed. For fundamental blockers, return BLOCKED and report worker_done failed.'
    : ''
  return [
    `Target: ${step.title}`,
    `Change: ${step.spec}`,
    evidence,
    'Constraints: Stay within this task. Do not change completed steps, commit or push without separate authorization.',
    'Ownership: Use the assigned workspace and the files needed for this step.',
    `Observable acceptance: Run each check and report the actual result:\n${acceptance}`,
    handoff ? `Continuation checkpoint:\n${handoff}` : '',
    'Check for unread coordinator messages at the start and before sending worker_done. They may contain a continuation checkpoint. In worker_done, include the actual outcome, a brief report, the files changed and the check results. Report failure if any required check did not pass.'
  ].filter(Boolean).join('\n\n')
}
