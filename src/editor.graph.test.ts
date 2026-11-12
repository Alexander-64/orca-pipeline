import { assert, test } from 'orca/testing'
import { deleteStep, insertStep, patchStep, waves } from './editor'
import { parseScenario } from './scenario'
import { DEFAULT_SCENARIO } from './types'

const base = () => parseScenario(DEFAULT_SCENARIO, { expandEvidence: false })

test('waves preserve forks, joins and dependency order regardless of source order', () => {
  let graph = insertStep(base())
  graph = insertStep(graph, 'implement')
  graph = patchStep(graph, 'review', { needs: ['step-3', 'step-4'] })
  assert.deepEqual(waves([...graph.steps].reverse()).map(wave => wave.map(step => step.id).sort()), [
    ['implement', 'step-3'], ['step-4'], ['review']
  ])
  assert.deepEqual(waves(base().steps).map(wave => wave.map(step => step.id)), [['implement'], ['review']])
})

test('deletion clears incoming edges and leaves the original untouched', () => {
  const graph = base()
  const next = deleteStep(graph, 'implement')
  assert.deepEqual(next.steps[0].needs, [])
  assert.deepEqual(graph.steps[1].needs, ['implement'])
  assert.throws(() => deleteStep(next, 'review'))
})

test('insert and duplicate allocate unique IDs after deletion', () => {
  const graph = deleteStep(insertStep(base()), 'review')
  const next = insertStep(graph, undefined, 'implement')
  assert.equal(next.steps.at(-1)?.id, 'step-4')
  assert.equal(next.steps.at(-1)?.title, 'Реализация (копия)')
  assert.equal(new Set(next.steps.map(step => step.id)).size, next.steps.length)
})

test('invalid edges, gates and commands are rejected without mutating the graph', () => {
  const graph = base()
  assert.throws(() => patchStep(graph, 'implement', { needs: ['review'] }))
  assert.throws(() => patchStep(graph, 'implement', { needs: ['implement'] }))
  assert.throws(() => patchStep(graph, 'implement', { needs: ['missing'] }))
  assert.throws(() => patchStep(graph, 'implement', { reviewAgent: graph.steps[0].agent }))
  assert.throws(() => patchStep(graph, 'implement', { acceptance: [] }))
  assert.deepEqual(graph.steps[0].needs, [])
})
