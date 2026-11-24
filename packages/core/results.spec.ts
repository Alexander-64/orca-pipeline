import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScenario, serializeScenario } from './scenario'
import { parseCondition, parseOutputSchema, validateResult, resultFromText, evaluateCondition, readiness } from './results'
import type { PipelineTask } from './types'
import { deleteStep, disconnectSteps } from './editor'

const source = `version: 2
name: branches
objective: Typed branching
steps:
 - id: decide
   title: Decide
   spec: Inspect
   agent: pi
   acceptance: [pwd]
   outputSchema:
     decision: {type: string, enum: [improve, pass]}
     score: {type: number, required: false}
 - id: improve
   title: Improve
   spec: Recommend
   agent: pi
   acceptance: [pwd]
   needs: [decide]
   when: {step: decide, field: decision, op: eq, value: improve}
`
const task = (data?: Record<string, string | number | boolean>): PipelineTask => ({ stepId: 'decide', taskId: 't', status: 'done', agent: 'pi', attempts: [], data })

test('v2 schema and typed conditions roundtrip while legacy scenarios remain v1', () => {
  const parsed = parseScenario(source)
  assert.deepEqual(parseScenario(serializeScenario(parsed)), parsed)
  assert.equal(parseScenario('name: old\nobjective: old\nsteps:\n - id: old\n   title: Old\n   spec: Inspect\n   agent: pi\n   acceptance: [pwd]').version, undefined)
  assert.throws(() => parseScenario(source.replace('version: 2', 'version: 1')), /version: 2/)
  assert.throws(() => parseScenario(source.replace('version: 2', 'version: 3')), /version|версии/)
  assert.throws(() => parseScenario(source.replace('op: eq, value: improve', 'op: gt, value: 7')), /type string/)
  assert.throws(() => parseScenario(source.replace('field: decision', 'field: absent')), /declared result/)
  assert.throws(() => parseScenario(source.replace('needs: [decide]', 'needs: []')), /predecessor/)
})

test('output validation rejects wrong, missing, extra and nonfinite fields; optional absence is valid', () => {
  const schema = parseOutputSchema({ decision: { type: 'string', enum: ['improve', 'pass'] }, score: { type: 'number', required: false } })
  assert.deepEqual(validateResult(schema, { decision: 'pass' }), { decision: 'pass' })
  for (const value of [{}, { decision: 'other' }, { decision: 1 }, { decision: 'pass', extra: true }, { decision: 'pass', score: Infinity }, { decision: 'pass', score: null }]) assert.throws(() => validateResult(schema, value))
  assert.throws(() => parseOutputSchema({ decision: { type: 'string', enum: [1] } }))
  assert.throws(() => parseOutputSchema({ constructor: { type: 'string' } }))
  assert.throws(() => parseOutputSchema({ decision: { type: 'string', eval: 'anything' } }))
})

test('text-only executors require a versioned JSON envelope rather than inferred prose', () => {
  const schema = { decision: { type: 'string' as const } }
  const envelope = JSON.stringify({ pipelineResult: { version: 1, data: { decision: 'pass' } }, report: 'Evidence' })
  assert.deepEqual(resultFromText(schema, envelope), { decision: 'pass' })
  assert.deepEqual(resultFromText(schema, '```json\n' + envelope + '\n```'), { decision: 'pass' })
  for (const value of ['decision: pass', 'Everything passed', '{"decision":"pass"}', envelope.replace('"version":1', '"version":2')]) assert.throws(() => resultFromText(schema, value))
})

test('conditions are bounded declarations; absent fields never accidentally satisfy ne', () => {
  const missing = parseCondition({ step: 'decide', field: 'score', op: 'ne', value: 1 })
  assert.equal(evaluateCondition(missing, { decide: task({ decision: 'pass' }) }), false)
  assert.equal(evaluateCondition(parseCondition({ step: 'decide', field: 'score', op: 'exists', value: false }), { decide: task({ decision: 'pass' }) }), true)
  const grouped = parseCondition({ all: [{ step: 'decide', field: 'score', op: 'gte', value: 5 }, { any: [{ step: 'decide', field: 'decision', op: 'eq', value: 'pass' }, { step: 'decide', field: 'score', op: 'gt', value: 9 }] }] })
  assert.equal(evaluateCondition(grouped, { decide: task({ decision: 'pass', score: 6 }) }), true)
  assert.equal(evaluateCondition(grouped, { decide: { ...task({ decision: 'pass', score: 6 }), status: 'failed' } }), false)
  for (const value of ['process.exit()', { eval: 'process.exit()' }, { all: [] }, { step: 'decide', field: 'score', op: 'exec', value: 'echo' }, { step: 'decide', field: 'score', op: 'exists', value: 'yes' }]) assert.throws(() => parseCondition(value))
})

test('joins wait for every predecessor; all_success propagates skip, all_settled permits a finalizer', () => {
  const step = parseScenario(source).steps[1]
  assert.equal(readiness(step, { decide: { ...task(), status: 'running' } }).state, 'wait')
  assert.equal(readiness(step, { decide: { ...task(), status: 'skipped' } }).state, 'skip')
  assert.equal(readiness({ ...step, when: undefined, join: 'all_settled' }, { decide: { ...task(), status: 'skipped' } }).state, 'ready')
  assert.equal(readiness(step, { decide: task({ decision: 'pass' }) }).state, 'skip')
})

test('deleting a producer prunes its conditions while evidence shorthand preserves ancestor references', () => {
  const graph = parseScenario(source, { expandEvidence: false })
  assert.equal(deleteStep(graph, 'decide').steps[0].when, undefined)
  assert.equal(disconnectSteps(graph, 'decide', 'improve').steps[1].when, undefined)
  const reviewed = parseScenario(source.replace('spec: Inspect', 'spec: Inspect\n   reviewAgent: reviewer'))
  assert.deepEqual(reviewed.steps.find(step => step.id === 'improve')!.needs, ['decide-evidence'])
  assert.equal(reviewed.steps.find(step => step.id === 'decide-evidence')!.outputSchema, undefined)
  assert.ok(reviewed.steps.find(step => step.id === 'improve')!.when)
})
