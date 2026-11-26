import { waves } from './editor'
import { readiness, validateResult } from './results'
import { parse, stringify } from '../../vendor/yaml/index.js'
import { parseScenario } from './scenario'
import type { PipelineRun, PipelineTask, Scenario } from './types'

export function rehearsal(scenario: Scenario, samples: Record<string, unknown>, failures: string[] = []) {
  const tasks: Record<string, PipelineTask> = Object.create(null)
  for (const step of waves(scenario.steps).flat()) {
    const decision = readiness(step, tasks)
    const task: PipelineTask = { taskId: step.id, stepId: step.id, attempts: [], agent: step.agent, status: 'done' }
    if (decision.state === 'skip') { task.status = 'skipped'; task.skipReason = decision.reason }
    else if (failures.includes(step.id)) task.status = 'failed'
    else if (step.outputSchema) {
      try { task.data = validateResult(step.outputSchema, samples[step.id] ?? {}) }
      catch (error) { throw new Error(step.id + ': ' + (error as Error).message) }
    }
    tasks[step.id] = task
  }
  return tasks
}

const token = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g
export function parameters(plan: Scenario): string[] {
  return [...new Set([plan.objective, ...plan.steps.flatMap(step => [step.title, step.spec])]
    .flatMap(text => Array.from(text.matchAll(token), match => match[1])))]
}

export function instantiate(source: string, values: Record<string, string>) {
  const plan = parseScenario(source, { expandEvidence: false })
  for (const key of parameters(plan)) {
    if (!Object.hasOwn(values, key) || !values[key]?.trim()) throw new Error('Missing parameter: ' + key)
  }
  const fill = (text: string) => text.replace(token, (_, key: string) => values[key])
  const raw = parse(source) as Scenario
  raw.objective = fill(raw.objective)
  for (const step of raw.steps) { step.spec = fill(step.spec); step.title = fill(step.title) }
  const result = stringify(raw)
  parseScenario(result)
  return result
}

export function compareRuns(before: PipelineRun, after: PipelineRun) {
  const canonical = (value: unknown): string => JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  const ids = new Set([...before.scenario.steps, ...after.scenario.steps].map(step => step.id))
  const snapshot = (run: PipelineRun, id: string) => {
    const step = run.scenario.steps.find(candidate => candidate.id === id)
    if (!step) return null
    const task = run.tasks[id], attempt = task?.attempts.at(-1)
    return { step, status: task?.status ?? 'pending', agent: task?.agent ?? step.agent,
      checks: attempt?.checks ?? [], filesModified: attempt?.filesModified, review: attempt?.review, data: task?.data, output: attempt?.output ?? '', error: task?.error }
  }
  return Array.from(ids, id => {
    const left = snapshot(before, id), right = snapshot(after, id)
    const lines = (side: typeof left) => new Set((side?.output ?? '').split(/\r?\n/).filter(line => line.trim()))
    const oldLines = lines(left), newLines = lines(right)
    return { id, left, right, changed: canonical(left) !== canonical(right),
      added: [...newLines].filter(line => !oldLines.has(line)), removed: [...oldLines].filter(line => !newLines.has(line)) }
  })
}

export const auditTemplate = `name: audit-improve-review
objective: "Review {{focus}} in {{project}}"
commandPolicy: {readOnly: true}
steps:
  - {id: audit, title: Audit, spec: "Inspect {{focus}} in the current project {{project}}. Cite relevant files.", agent: codex, acceptance: [pwd]}
  - {id: improve, needs: [audit], title: Improvements, spec: "Use the audit report to propose improvements for {{focus}} with concrete validation steps.", agent: codex, acceptance: [pwd]}
  - {id: review, needs: [improve], title: Independent review, spec: "Verify the recommendations for {{focus}} against the relevant files and report confirmed and unsupported findings.", agent: codex, acceptance: [pwd]}
`
