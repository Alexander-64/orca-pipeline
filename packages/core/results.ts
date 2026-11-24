import type { Condition, OutputSchema, PipelineTask, Predicate, ResultValue, ScenarioStep, StructuredData } from './types'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is ResultValue => ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))
const safeField = (field: string) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) && !['constructor', 'prototype', '__proto__'].includes(field)
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}: unsupported field ${key}`)
}

export function parseOutputSchema(value: unknown): OutputSchema {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 32) throw new Error('outputSchema: expected 1–32 named scalar fields')
  return Object.fromEntries(Object.entries(value).map(([field, spec]) => {
    if (!safeField(field) || !object(spec) || !['string', 'number', 'boolean'].includes(String(spec.type))) throw new Error(`outputSchema.${field}: expected string, number or boolean type`)
    keys(spec, ['type', 'required', 'enum'], 'outputSchema.' + field)
    if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new Error('outputSchema.required: expected boolean')
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || !spec.enum.length || spec.enum.length > 32 || spec.enum.some(item => !scalar(item) || typeof item !== spec.type))) throw new Error('outputSchema.enum: values must match the field type')
    return [field, { type: spec.type as 'string' | 'number' | 'boolean', ...(spec.required !== undefined ? { required: spec.required } : {}), ...(spec.enum ? { enum: spec.enum as ResultValue[] } : {}) }]
  }))
}

export function parseCondition(value: unknown, depth = 0): Condition {
  if (!object(value) || depth > 4) throw new Error('when: expected a bounded declarative condition')
  for (const group of ['all', 'any'] as const) if (group in value) {
    keys(value, [group], 'when')
    const children = value[group]
    if (!Array.isArray(children) || !children.length || children.length > 10) throw new Error('when: all/any requires 1–10 conditions')
    return { [group]: children.map(child => parseCondition(child, depth + 1)) } as Condition
  }
  keys(value, ['step', 'field', 'op', 'value'], 'when')
  if (typeof value.step !== 'string' || typeof value.field !== 'string' || !safeField(value.field)
    || !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'].includes(String(value.op)) || !scalar(value.value)) throw new Error('when: expected step, field, op and scalar value')
  if (value.op === 'exists' && typeof value.value !== 'boolean') throw new Error('when.exists: value must be boolean')
  return { step: value.step, field: value.field, op: value.op as Predicate['op'], value: value.value }
}

export function predicates(condition: Condition): Predicate[] {
  if ('all' in condition) return condition.all.flatMap(predicates)
  if ('any' in condition) return condition.any.flatMap(predicates)
  return [condition]
}

export function filterCondition(condition: Condition | undefined, keep: (predicate: Predicate) => boolean): Condition | undefined {
  if (!condition) return undefined
  for (const group of ['all', 'any'] as const) if (group in condition) {
    const children = (condition as { all?: Condition[]; any?: Condition[] })[group]!.map(child => filterCondition(child, keep)).filter((child): child is Condition => !!child)
    return children.length ? children.length === 1 ? children[0] : { [group]: children } as Condition : undefined
  }
  return keep(condition as Predicate) ? condition : undefined
}

export function appendCondition(previous: Condition | undefined, clause: Condition, group: 'all' | 'any' = 'all'): Condition {
  if (!previous) return clause
  if (JSON.stringify(previous) === JSON.stringify(clause)) return previous
  const children = group in previous ? (previous as { all?: Condition[]; any?: Condition[] })[group]! : [previous]
  return { [group]: [...children, clause] } as Condition
}

export function conditionLabel(condition: Condition, language: 'en' | 'ru' = 'ru'): string {
  if ('all' in condition) return '(' + condition.all.map(item => conditionLabel(item, language)).join(language === 'en' ? ' AND ' : ' И ') + ')'
  if ('any' in condition) return '(' + condition.any.map(item => conditionLabel(item, language)).join(language === 'en' ? ' OR ' : ' ИЛИ ') + ')'
  if (condition.op === 'exists') return `${condition.step}.${condition.field} ${condition.value ? (language === 'en' ? 'exists' : 'существует') : (language === 'en' ? 'is absent' : 'отсутствует')}`
  const operators = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
  return `${condition.step}.${condition.field} ${operators[condition.op]} ${JSON.stringify(condition.value)}`
}

export function conditionValue(type: 'string' | 'number' | 'boolean', op: Predicate['op'], text: string): ResultValue {
  if (op === 'exists' || type === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('Укажите true или false')
    return text === 'true'
  }
  if (type === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Укажите конечное число')
    return Number(text)
  }
  return text
}

export function predecessorFields(step: ScenarioStep, steps: ScenarioStep[]): { step: string; field: string; type: 'string' | 'number' | 'boolean'; enum?: ResultValue[] }[] {
  const ancestors = new Set<string>()
  const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); for (const need of steps.find(step => step.id === id)?.needs ?? []) visit(need) }
  step.needs.forEach(visit)
  return steps.filter(candidate => ancestors.has(candidate.id)).flatMap(candidate => Object.entries(candidate.outputSchema ?? {}).map(([field, spec]) => ({ step: candidate.id, field, type: spec.type, enum: spec.enum })))
}

export function validateConditionReferences(step: ScenarioStep, steps: Map<string, ScenarioStep>): void {
  if (!step.when) return
  const ancestors = new Set<string>()
  const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); for (const need of steps.get(id)?.needs ?? []) visit(need) }
  step.needs.forEach(visit)
  for (const predicate of predicates(step.when)) {
    const field = steps.get(predicate.step)?.outputSchema?.[predicate.field]
    if (!ancestors.has(predicate.step) || !field) throw new Error(`when.${step.id}: ${predicate.step}.${predicate.field} must be a declared result of a predecessor`)
    if (predicate.op === 'exists') continue
    if (typeof predicate.value !== field.type) throw new Error(`when.${step.id}: comparison value must have type ${field.type}`)
    if (['gt', 'gte', 'lt', 'lte'].includes(predicate.op) && field.type !== 'number') throw new Error('when: ordered comparisons require numbers')
  }
}

export function validateResult(schema: OutputSchema, value: unknown): StructuredData {
  if (!object(value)) throw new Error('Structured result must be an object')
  if (JSON.stringify(value).length > 32_000) throw new Error('Structured result exceeds 32000 characters')
  for (const field of Object.keys(value)) if (!Object.hasOwn(schema, field)) throw new Error('Undeclared result field: ' + field)
  const data: StructuredData = {}
  for (const [field, spec] of Object.entries(schema)) {
    if (!Object.hasOwn(value, field)) { if (spec.required !== false) throw new Error('Missing result field: ' + field); continue }
    const item = value[field]
    if (!scalar(item) || typeof item !== spec.type || (spec.enum && !spec.enum.includes(item))) throw new Error('Invalid result field: ' + field)
    data[field] = item
  }
  return data
}

// Text-only executors return one explicit JSON envelope, never inferred prose.
export function resultFromText(schema: OutputSchema, text: string): StructuredData {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim())
  let value: unknown
  try { value = JSON.parse(match?.[1] ?? text.trim()) } catch { throw new Error('Expected JSON {pipelineResult: {version: 1, data: {...}}, report: "..."}') }
  if (!object(value) || !object(value.pipelineResult) || value.pipelineResult.version !== 1) throw new Error('Missing pipelineResult version 1 envelope')
  return validateResult(schema, value.pipelineResult.data)
}

export function resultInstructions(schema: OutputSchema): string {
  return `Structured result schema (all fields required unless required:false): ${JSON.stringify(schema)}. If submit_result is available, submit validated data using that tool, then return a human-readable report. Otherwise return your COMPLETE final report as a single JSON object {"pipelineResult":{"version":1,"data":{...}},"report":"evidence and limitations"}. No surrounding prose. Missing/invalid data fails the step independently of your report.`
}

export function evaluateCondition(condition: Condition, tasks: Record<string, PipelineTask>): boolean {
  if ('all' in condition) return condition.all.every(child => evaluateCondition(child, tasks))
  if ('any' in condition) return condition.any.some(child => evaluateCondition(child, tasks))
  const task = tasks[condition.step]
  const present = task?.status === 'done' && !!task.data && Object.hasOwn(task.data, condition.field)
  if (condition.op === 'exists') return present === condition.value
  if (!present) return false // Missing fields do not satisfy even ne.
  const value = task.data![condition.field], expected = condition.value
  switch (condition.op) {
    case 'eq': return value === expected
    case 'ne': return value !== expected
    case 'gt': return typeof value === 'number' && typeof expected === 'number' && value > expected
    case 'gte': return typeof value === 'number' && typeof expected === 'number' && value >= expected
    case 'lt': return typeof value === 'number' && typeof expected === 'number' && value < expected
    case 'lte': return typeof value === 'number' && typeof expected === 'number' && value <= expected
  }
}

export function readiness(step: ScenarioStep, tasks: Record<string, PipelineTask>): { state: 'wait' | 'ready' | 'skip'; reason?: string } {
  const dependencies = step.needs.map(id => tasks[id])
  if (dependencies.some(task => !task || !['done', 'failed', 'skipped'].includes(task.status))) return { state: 'wait' }
  if (step.join !== 'all_settled' && dependencies.some(task => task.status !== 'done')) return { state: 'skip', reason: 'A predecessor failed or was skipped; all_success requires every predecessor to succeed' }
  if (step.when && !evaluateCondition(step.when, tasks)) return { state: 'skip', reason: 'Condition evaluated to false: ' + JSON.stringify(step.when) }
  return { state: 'ready' }
}
