import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleWidth } from '@earendil-works/pi-tui'
import { editScenario, renderView, setStage, interactionCommand, type ViewModel } from './view'
import { parseScenario, serializeScenario } from '../core/scenario'

const scenario = () => parseScenario('name: flow\nobjective: Analyze\ncommandPolicy: {readOnly: true}\nsteps:\n  - id: audit\n    title: Анализ проекта\n    spec: Read the project\n    agent: pi\n    acceptance: [pwd]\n  - id: review\n    title: Независимое ревью\n    spec: Verify findings\n    agent: pi\n    needs: [audit]\n    acceptance: [pwd]\n')
const model = (): ViewModel => ({ project: '/project', stage: 1, goal: 'Audit', offset: 0, follow: true, activity: {} })

test('messages preserve free text and answers require a waiting question', () => {
  assert.deepEqual(interactionCommand(':send keep $X; "quotes"\nnext line'), { text: 'keep $X; "quotes"\nnext line' })
  assert.deepEqual(interactionCommand(':answer yes', 'q1'), { text: 'yes', questionId: 'q1' })
  assert.throws(() => interactionCommand(':answer yes'), /вопроса/)
  assert.equal(interactionCommand(':run'), undefined)
})

test('stage navigation requires a scenario, preserves draft, and does not start work', () => {
  const state = model()
  assert.throws(() => setStage(state, 2), /сценарий/)
  state.scenario = scenario(); state.source = serializeScenario(state.scenario)
  const source = state.source
  setStage(state, 2); setStage(state, 3); setStage(state, 1)
  assert.equal(state.source, source); assert.equal(state.run, undefined)
})

test('editor links are semantic dependencies, reject cycles and roundtrip to YAML', () => {
  const base = scenario()
  assert.throws(() => editScenario(base, 'link review audit', ['pi']), /цикл/)
  const independent = editScenario(base, 'unlink audit review', ['pi'])
  assert.deepEqual(independent.steps[1].needs, [])
  const linked = editScenario(independent, 'link audit review', ['pi'])
  assert.deepEqual(parseScenario(serializeScenario(linked)).steps[1].needs, ['audit'])
  assert.throws(() => editScenario(linked, 'agent review missing', ['pi']), /Неизвестный/)
})

test('terminal editor declares outputs, adds a typed condition and removes it with its connection', () => {
  let graph = editScenario(scenario(), 'schema audit {"decision":{"type":"string","enum":["improve","pass"]}}', ['pi'])
  graph = editScenario(graph, 'condition review audit decision eq improve', ['pi'])
  graph = editScenario(graph, 'join review all_settled', ['pi'])
  assert.equal(graph.version, 2)
  assert.deepEqual(graph.steps[1].when, { step: 'audit', field: 'decision', op: 'eq', value: 'improve' })
  assert.equal(graph.steps[1].join, 'all_settled')
  const serialized = serializeScenario(graph)
  assert.deepEqual(parseScenario(serialized).steps[1].when, graph.steps[1].when)
  const disconnected = editScenario(graph, 'unlink audit review', ['pi'])
  assert.equal(disconnected.steps[1].when, undefined)
  assert.equal(graph.steps[1].when !== undefined, true)
  assert.throws(() => editScenario(graph, 'schema audit off', ['pi']), /declared result/)
  assert.equal(editScenario(graph, 'when review off', ['pi']).steps[1].when, undefined)
  assert.equal(editScenario(graph, 'add fresh review', ['pi']).steps[2].outputSchema, undefined)
})

test('terminal layouts fit narrow, wide and fullscreen dimensions and strip control sequences', () => {
  const state = model(); state.scenario = scenario(); state.stage = 2; state.selected = 'audit'
  state.scenario.steps[0].spec = '\x1b[2J' + 'Длинный текст '.repeat(100)
  for (const width of [24, 60, 100, 160]) for (const full of [false, true]) {
    state.full = full
    const lines = renderView(state, width, 20)
    assert.equal(lines.length, 20)
    assert.ok(lines.every(line => visibleWidth(line) <= width))
    assert.ok(lines.every(line => !line.includes('\x1b')))
  }
})

test('manual approval editing and adding a dependent step keep existing steps intact', () => {
  const base = scenario()
  const gated = editScenario(base, 'approval review "Разрешить ревью"', ['pi'])
  assert.equal(gated.steps[1].approval, 'Разрешить ревью')
  const expanded = editScenario(gated, 'add summary review', ['pi'])
  assert.equal(expanded.steps.length, 3)
  assert.deepEqual(expanded.steps[2].needs, ['review'])
  assert.equal(expanded.steps[2].approval, undefined)
  assert.equal(base.steps[1].approval, undefined)
})
