import { parseScenario, serializeScenario } from './scenario'
import type { Scenario, ScenarioStep } from './types'

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
  return validateGraph({ ...scenario, steps: scenario.steps.map(step => step.id === id ? { ...step, ...patch, id } : step) })
}

export function insertStep(scenario: Scenario, parent?: string, duplicate?: string): Scenario {
  let index = scenario.steps.length + 1
  const reserved = new Set(scenario.steps.flatMap(step => [step.id, `${step.id}-evidence`]))
  while (reserved.has(`step-${index}`)) index++
  const source = scenario.steps.find(step => step.id === duplicate)
  const step: ScenarioStep = source ? { ...source, id: `step-${index}`, title: `${source.title} (копия)` } : {
    id: `step-${index}`, title: `Шаг ${index}`, spec: 'Опиши результат и границы изменений',
    needs: parent ? [parent] : [], agent: 'codex', fallback: ['claude'],
    placement: { host: 'local', worktree: 'current' }, acceptance: ['npm test'], maxAttempts: 3, maxRepairs: 2
  }
  return validateGraph({ ...scenario, steps: [...scenario.steps, step] })
}

export function deleteStep(scenario: Scenario, id: string): Scenario {
  return validateGraph({ ...scenario, steps: scenario.steps.filter(step => step.id !== id)
    .map(step => ({ ...step, needs: step.needs.filter(need => need !== id) })) })
}
