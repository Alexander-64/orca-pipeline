import test from 'node:test'
import assert from 'node:assert/strict'
import { auditTemplate, compareRuns, instantiate, parameters, rehearsal } from './workflow-tools'
import { parseScenario } from './scenario'
import { demoRun } from '../../src/testData'

test('one template safely binds two project paths and multiline YAML-looking values', () => {
  const focus = 'README:\n  agent: something else\n$&'
  for (const project of ['/a/Jarvis', '/b/Agent Pipeline']) {
    const scenario = parseScenario(instantiate(auditTemplate, { project, focus }))
    assert.ok(scenario.steps.every(step => step.agent === 'codex' && step.spec.includes(focus)))
    assert.equal(scenario.objective, 'Review ' + focus + ' in ' + project)
    assert.deepEqual(scenario.steps.map(s => s.needs), [[], ['audit'], ['improve']])
    assert.deepEqual(parameters(scenario), [])
  }
  assert.throws(() => instantiate(auditTemplate, { project: '/demo' }), /Missing parameter: focus/)
})

const branch = parseScenario(`version: 2
name: branches
objective: choose
steps:
 - {id: choose, title: Choose, spec: Select, agent: pi, acceptance: [pwd], outputSchema: {choice: {type: string, enum: [go, hold]}}}
 - {id: go, title: Go, spec: Proceed, agent: pi, needs: [choose], when: {step: choose, field: choice, op: eq, value: go}, acceptance: [pwd]}
 - {id: end, title: End, spec: Finish, agent: pi, needs: [go], join: all_settled, acceptance: [pwd]}
`)
test('rehearses actions, skips, failures and settled joins with execution predicates', () => {
  assert.equal(rehearsal(branch, { choose: { choice: 'go' } }).go.status, 'done')
  assert.match(rehearsal(branch, { choose: { choice: 'hold' } }).go.skipReason!, /Condition/)
  const failed = rehearsal(branch, {}, ['choose'])
  assert.deepEqual(Object.values(failed).map(s => s.status), ['failed', 'skipped', 'done'])
  assert.throws(() => rehearsal(branch, { choose: { choice: 'other' } }), /choose: Invalid result/)
  assert.equal(branch.steps.length, 3)
})

test('compares immutable definitions, report lines and checks across added and removed steps', () => {
  const before = structuredClone(demoRun), after = structuredClone(demoRun)
  before.tasks.build.attempts[0].output = 'same\nold'
  after.tasks.build.attempts[0].output = 'new\nsame'
  after.tasks.build.attempts[0].checks = [{ command: 'pwd', exitCode: 4 }]
  before.scenario.steps.push({ ...before.scenario.steps[0], id: 'removed' })
  after.scenario.steps.push({ ...after.scenario.steps[0], id: 'extra' })
  const rows = compareRuns(before, after)
  assert.equal(rows[0].changed, true)
  assert.deepEqual([rows[0].added, rows[0].removed], [['new'], ['old']])
  assert.equal(rows[0].right?.checks[0].exitCode, 4)
  assert.equal(rows[1].right, null)
  assert.equal(rows[2].left, null)
  assert.ok(compareRuns(before, structuredClone(before)).every(row => !row.changed))
})
