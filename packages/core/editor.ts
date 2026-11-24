import { parseScenario, serializeScenario } from './scenario'
import type { Scenario, ScenarioStep } from './types'
import { filterCondition, predecessorFields } from './results'

export function waves(steps: ScenarioStep[]): ScenarioStep[][] {
  const remaining = [...steps]
  const done = new Set<string>()
  const result: ScenarioStep[][] = []
  while (remaining.length) {
    const wave = remaining.filter(step => step.needs.every(id => done.has(id)))
    if (!wave.length) throw new Error('Цикл или неизвестная зависимость')
    result.push(wave)
    for (const step of wave) {
      done.add(step.id)
      remaining.splice(remaining.indexOf(step), 1)
    }
  }
  return result
}

export function validateGraph(scenario: Scenario): Scenario {
  const source = serializeScenario(scenario)
  parseScenario(source) // Also validate generated Evidence Gates.
  return parseScenario(source, { expandEvidence: false })
}

export function patchStep(scenario: Scenario, id: string, patch: Partial<ScenarioStep>): Scenario {
  if (!scenario.steps.some(step => step.id === id)) throw new Error('Неизвестный шаг: ' + id)
  return validateGraph({ ...scenario, ...(patch.when || patch.outputSchema || patch.join ? { version: 2 as const } : {}), steps: scenario.steps.map(step => step.id === id ? { ...step, ...patch, id } : step) })
}

export function insertStep(scenario: Scenario, parent?: string, duplicate?: string, language: 'en' | 'ru' = 'ru'): Scenario {
  let index = scenario.steps.length + 1
  const reserved = new Set(scenario.steps.flatMap(step => [step.id, `${step.id}-evidence`]))
  while (reserved.has(`step-${index}`)) index++
  const source = scenario.steps.find(step => step.id === duplicate)
  const step: ScenarioStep = source ? { ...source, id: `step-${index}`, title: language === 'en' ? `${source.title} (copy)` : `${source.title} (копия)` } : {
    id: `step-${index}`, title: language === 'en' ? `Step ${index}` : `Шаг ${index}`,
    spec: language === 'en' ? 'Describe the result and scope of the change' : 'Опиши результат и границы изменений',
    needs: parent ? [parent] : [], agent: 'codex', fallback: ['claude'],
    placement: { host: 'local', worktree: 'current' }, acceptance: ['npm test'], maxAttempts: 3, maxRepairs: 2
  }
  return validateGraph({ ...scenario, steps: [...scenario.steps, step] })
}

export function deleteStep(scenario: Scenario, id: string): Scenario {
  return pruneConnections({ ...scenario, steps: scenario.steps.filter(step => step.id !== id)
    .map(step => ({ ...step, needs: step.needs.filter(need => need !== id) })) })
}

function pruneConnections(scenario: Scenario): Scenario {
  return validateGraph({ ...scenario, steps: scenario.steps.map(step => {
    if (!step.when) return step
    const fields = predecessorFields(step, scenario.steps)
    return { ...step, when: filterCondition(step.when, condition => fields.some(field => field.step === condition.step && field.field === condition.field)) }
  }) })
}

export function connectSteps(scenario: Scenario, from: string, to: string): Scenario {
  const target = scenario.steps.find(step => step.id === to)
  if (!target || !scenario.steps.some(step => step.id === from)) throw new Error('Неизвестный шаг связи')
  return patchStep(scenario, to, { needs: [...new Set([...target.needs, from])] })
}
export function disconnectSteps(scenario: Scenario, from: string, to: string): Scenario {
  const target = scenario.steps.find(step => step.id === to)
  if (!target) throw new Error('Неизвестный шаг связи')
  return pruneConnections({ ...scenario, steps: scenario.steps.map(step => step.id === to ? { ...step, needs: step.needs.filter(id => id !== from) } : step) })
}
