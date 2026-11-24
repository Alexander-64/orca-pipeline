import { stepForAgent } from './agent-preferences'
import { parse, stringify } from '../../vendor/yaml/index.js'
import { validateAcceptance } from './commands'
import type { AgentPolicy, Scenario, ScenarioStep } from './types'
import { parseCondition, parseOutputSchema, resultInstructions, validateConditionReferences } from './results'
import { reviewInstructions } from './review'

const ID = /^[a-z][a-z0-9-]*$/
const WORKSPACES = new Set(['current', 'new-child', 'new-top-level'])

function agentPreferences(value: unknown): ScenarioStep['agentPreferences'] {
  if (value === undefined) return undefined
  const entries = object(value, 'agentPreferences')
  return Object.fromEntries(Object.entries(entries).map(([agent, value]) => {
    const fields = object(value, `agentPreferences.${agent}`)
    const model = fields.model === undefined ? undefined : text(fields.model, `agentPreferences.${agent}.model`)
    const effort = fields.effort === undefined ? undefined : text(fields.effort, `agentPreferences.${agent}.effort`)
    if (effort && !model) throw new Error(`agentPreferences.${agent}: effort требует model`)
    return [agent, { model, effort }]
  }))
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: ожидается объект`)
  return value as Record<string, unknown>
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${path}: нужна непустая строка`)
  return value.trim()
}

function strings(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path}: ожидается список строк`)
  return value.map((item, index) => text(item, `${path}[${index}]`))
}

function positiveInteger(value: unknown, path: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 16) throw new Error(`${path}: допустимо от 1 до 16`)
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

function stepFrom(value: unknown, index: number, roles?: Record<string, AgentPolicy>, version = 1): ScenarioStep {
  const raw = object(value, `steps[${index}]`)
  for (const field of ['if', 'condition', ...(version === 1 ? ['when', 'join', 'outputSchema'] : [])]) {
    if (field in raw) throw new Error(`steps[${index}].${field}: используйте version: 2 и декларативное when; approval остаётся ручным подтверждением`)
  }
  if (raw.join !== undefined && !['all_success', 'all_settled'].includes(String(raw.join))) throw new Error('join: expected all_success or all_settled')
  const id = text(raw.id, `steps[${index}].id`)
  if (!ID.test(id)) throw new Error(`steps[${index}].id: используйте строчные буквы, цифры и дефис`)
  const placementRaw = raw.placement === undefined ? {} : object(raw.placement, `steps[${index}].placement`)
  const host = placementRaw.host === undefined ? 'local' : text(placementRaw.host, `steps[${index}].placement.host`)
  const worktree = placementRaw.worktree === undefined
    ? 'current'
    : text(placementRaw.worktree, `steps[${index}].placement.worktree`)
  if (host !== 'local' && worktree === 'current') {
    throw new Error(`steps[${index}]: для remote нужен exact workspace selector или new-top-level`)
  }
  if (host !== 'local' && WORKSPACES.has(worktree) && worktree !== 'current' && placementRaw.repo === undefined) {
    throw new Error(`steps[${index}]: для нового remote worktree нужен placement.repo`)
  }
  const attempts = raw.maxAttempts === undefined ? 3 : Number(raw.maxAttempts)
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error(`steps[${index}].maxAttempts: допустимо от 1 до 3`)
  }
  const repairs = raw.maxRepairs === undefined ? 2 : Number(raw.maxRepairs)
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > 2) {
    throw new Error(`steps[${index}].maxRepairs: допустимо от 0 до 2`)
  }
  const acceptance = strings(raw.acceptance, `steps[${index}].acceptance`)
  if (acceptance.length === 0) throw new Error(`steps[${index}].acceptance: нужна хотя бы одна проверка`)
  const setup = placementRaw.setup === undefined ? undefined : text(placementRaw.setup, `steps[${index}].placement.setup`)
  if (setup && !['run', 'skip', 'inherit'].includes(setup)) throw new Error(`steps[${index}].placement.setup: run, skip или inherit`)
  const routingRole = raw.role === undefined ? undefined : text(raw.role, `steps[${index}].role`)
  const policy = routingRole ? roles?.[routingRole] : undefined
  if (routingRole && !policy) throw new Error(`steps[${index}]: неизвестная роль ${routingRole}`)
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
    agentPreferences: agentPreferences(raw.agentPreferences),
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
    approval: raw.approval === undefined ? undefined : text(raw.approval, `steps[${index}].approval`),
    ...(raw.outputSchema !== undefined ? { outputSchema: parseOutputSchema(raw.outputSchema) } : {}),
    ...(raw.when !== undefined ? { when: parseCondition(raw.when) } : {}),
    ...(raw.join !== undefined ? { join: raw.join as ScenarioStep['join'] } : {})
  }
}

function expandEvidenceGates(steps: ScenarioStep[]): ScenarioStep[] {
  const evidenceIds = new Map<string, string>()
  for (const step of steps) {
    if (!step.reviewAgent) continue
    if (step.reviewAgent === step.agent) throw new Error(`steps.${step.id}: reviewAgent должен отличаться от исполнителя`)
    const id = `${step.id}-evidence`
    if (steps.some((candidate) => candidate.id === id)) throw new Error(`steps.${step.id}: ${id} уже существует`)
    evidenceIds.set(step.id, id)
  }
  const expanded: ScenarioStep[] = []
  for (const step of steps) {
    expanded.push({ ...step, needs: step.needs.map((id) => evidenceIds.get(id) ?? id) })
    if (!step.reviewAgent) continue
    expanded.push({
      ...stepForAgent(step, step.reviewAgent),
      id: `${step.id}-evidence`,
      title: `Evidence Gate: ${step.title}`,
      spec: `Независимо проверь «${step.title}»: изучи доступные изменения и фактический результат. Исходное задание автора:\n${step.spec}\n\nНе исправляй код сам. Runtime отдельно выполняет acceptance-команды: ${JSON.stringify(step.acceptance)}. Не утверждай, что выполнил команду, без фактического доказательства. Верни вердикт SHIP, FIX-FIRST или BLOCKED с конкретными доказательствами.`,
      needs: [step.id],
      agent: step.reviewAgent,
      fallback: step.fallback.filter((agent) => agent !== step.reviewAgent && agent !== step.agent),
      reviewAgent: undefined,
      role: 'evidence',
      gateFor: step.id,
      repairRound: 0,
      when: undefined, join: undefined, outputSchema: undefined
    })
  }
  if (expanded.length > 100) throw new Error('steps: максимум 100 шагов с Evidence Gates')
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
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) throw new Error('scenario.version: поддерживаются версии 1 и 2')
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('steps: нужен хотя бы один шаг')
  if (raw.steps.length > 50) throw new Error('steps: максимум 50 шагов')
  const roles = parseRoles(raw.roles)
  const steps = options.expandEvidence === false
    ? raw.steps.map((step, index) => stepFrom(step, index, roles, raw.version === 2 ? 2 : 1))
    : expandEvidenceGates(raw.steps.map((step, index) => stepFrom(step, index, roles, raw.version === 2 ? 2 : 1)))
  const byId = new Map<string, ScenarioStep>()
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`steps: повторяющийся id ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of steps) {
    if (new Set([step.agent, ...step.fallback]).size !== step.fallback.length + 1) {
      throw new Error(`steps.${step.id}: агент не должен повторяться в fallback`)
    }
    for (const dependency of step.needs) {
      if (!byId.has(dependency)) throw new Error(`steps.${step.id}: неизвестная зависимость ${dependency}`)
      if (dependency === step.id) throw new Error(`steps.${step.id}: шаг зависит от себя`)
    }
    if (step.effort && !step.model) throw new Error(`steps.${step.id}: effort требует model`)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`steps: цикл зависимостей через ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.needs) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
  for (const step of steps) validateConditionReferences(step, byId)
  const policyRaw = raw.commandPolicy === undefined ? undefined : object(raw.commandPolicy, 'commandPolicy')
  const commandPolicy = policyRaw ? {
    allowedCommands: policyRaw.allowedCommands === undefined ? undefined : strings(policyRaw.allowedCommands, 'commandPolicy.allowedCommands'),
    readOnly: policyRaw.readOnly === true
  } : undefined
  for (const step of steps) validateAcceptance(step.acceptance, commandPolicy)
  const quotaThreshold = raw.quotaThreshold === undefined ? 95 : Number(raw.quotaThreshold)
  if (!Number.isFinite(quotaThreshold) || quotaThreshold < 1 || quotaThreshold > 100) throw new Error('quotaThreshold: допустимо от 1 до 100')
  const prRaw = raw.pullRequest === undefined ? undefined : object(raw.pullRequest, 'pullRequest')
  if (prRaw?.merge && !prRaw.mergeApproval) throw new Error('pullRequest.mergeApproval обязателен при merge')
  const pullRequest = prRaw ? {
    base: text(prRaw.base, 'pullRequest.base'),
    merge: prRaw.merge === true,
    mergeApproval: prRaw.mergeApproval === undefined ? undefined : text(prRaw.mergeApproval, 'pullRequest.mergeApproval')
  } : undefined
  let layout: Scenario['layout']
  if (raw.layout !== undefined) {
    const coordinates = object(raw.layout, 'layout')
    layout = Object.fromEntries(Object.entries(coordinates).map(([id, value]) => {
      const point = object(value, `layout.${id}`)
      if (![point.x, point.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20000)) throw new Error(`layout.${id}: координаты от 0 до 20000`)
      return [id, { x: point.x as number, y: point.y as number }]
    }))
  }
  return {
    ...(raw.version !== undefined ? { version: raw.version as 1 | 2 } : {}),
    name: text(raw.name, 'name'),
    objective: text(raw.objective, 'objective'),
    steps,
    ...(layout ? { layout } : {}),
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

export function checkpointFile(runId: string, stepId: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'unknown'
  return `.agent-pipeline/artifacts/${safe(runId)}/${safe(stepId)}.checkpoint.json`
}

export function taskSpec(step: ScenarioStep, handoff?: string, pipelineRunId?: string, stateFiles = true, workspacePath?: string): string {
  const artifactRoot = workspacePath ? `${workspacePath.replace(/[\\/]+$/, '')}/.agent-pipeline/artifacts/${pipelineRunId ?? ''}` : '.agent-pipeline/artifacts/' + pipelineRunId
  const checkpoint = pipelineRunId && workspacePath ? `${workspacePath.replace(/[\\/]+$/, '')}/${checkpointFile(pipelineRunId, step.id)}` : pipelineRunId ? checkpointFile(pipelineRunId, step.id) : ''
  const acceptance = step.acceptance.map((command, index) => `${index + 1}. ${command}`).join('\n')
  const evidence = step.role === 'evidence'
    ? 'Ты независимый reviewer, а не автор изменения. Вердикт SHIP означает worker_done succeeded. При исправимых проблемах верни FIX-FIRST и worker_done failed; при фундаментальных — BLOCKED и worker_done failed.'
    : ''
  return [
    `Target: ${step.title}`,
    `Change: ${step.spec}`,
    evidence,
    step.role === 'evidence' ? reviewInstructions : '',
    pipelineRunId ? `Before doing any work, read the continuation checkpoint file ${JSON.stringify(checkpoint)} if it exists. It contains the coordinator's verified previous-attempt context. A missing file on the first attempt is normal. Follow the checkpoint before repeating any work.` : '',
    workspacePath ? `Runtime context directory: ${JSON.stringify(artifactRoot)}. These pipeline-owned inputs are separate from the task source directory; read them at these exact paths even if you run source checks from another directory. Do not search for them relative to the source checkout.` : '',
    pipelineRunId && stateFiles && step.needs.length ? `Pipeline inputs: ${step.needs.join(', ')}. The runtime owns dependency readiness. Read predecessor JSON artifacts in ${JSON.stringify(artifactRoot)} before starting: <stepId>.state.json gives the actual task status, validated data, skip/error reason and report artifact paths. Attempt artifacts contain checks and the full report. A skipped predecessor has a state file but no worker report. Do not infer success from a missing report.` : '',
    step.outputSchema ? resultInstructions(step.outputSchema) : '',
    'Constraints: работай только в рамках этой задачи; не меняй завершённые шаги и не выполняй commit/push без отдельного указания.',
    'Ownership: текущий назначенный workspace и файлы, необходимые для этого шага.',
    `Observable acceptance: выполни каждую проверку и включи фактический результат в отчёт:\n${acceptance}`,
    handoff ? `Continuation checkpoint:\n${handoff}` : '',
    'В начале работы и перед worker_done проверь непрочитанные сообщения coordinator. Continuation checkpoint читается из указанного файла до начала работы. В worker_done укажи реальный outcome, краткий отчёт, изменённые файлы и результаты проверок; не объявляй успех при непройденной проверке.'
  ].filter(Boolean).join('\n\n')
}

// Detect an explicit task boundary; ordinary source references are not restrictions.
export function workspaceRestrictionConflicts(scenario: Scenario, sourcePath: string): ScenarioStep[] {
  const normalized = sourcePath.replace(/[\\/]+$/, '')
  if (!normalized) return []
  return scenario.steps.filter(step => step.spec.split(/\r?\n/).some(line => {
    const index = line.indexOf(normalized)
    if (index < 0) return false
    const prefix = line.slice(Math.max(0, index - 100), index)
    return /(?:только|only)\s+(?:(?:в|in|inside|under|within)\s+)?[`"']?$/i.test(prefix)
  }))
}
