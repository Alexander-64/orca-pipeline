import { assert, test } from 'orca/testing'
import { parseScenario } from './scenario'

const valid = `name: validation
objective: validation
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [test]
`

test('rejects duplicate step IDs', () => {
  const duplicate = `${valid}${valid.split('steps:\n')[1]}`
  assert.throws(() => parseScenario(duplicate), /duplicate id/)
})

test('rejects an unknown dependency', () => {
  assert.throws(() => parseScenario(valid.replace('    agent: codex', '    needs: [missing]\n    agent: codex')), /unknown dependency missing/)
})

test('rejects attempts outside one to three', () => {
  assert.throws(() => parseScenario(valid.replace('    agent: codex', '    agent: codex\n    maxAttempts: 0')), /maxAttempts/)
  assert.throws(() => parseScenario(valid.replace('    agent: codex', '    agent: codex\n    maxAttempts: 4')), /maxAttempts/)
})

test('requires an exact repository for a new remote worktree', () => {
  const source = valid.replace('    agent: codex', '    agent: codex\n    placement: { host: remote, worktree: new-top-level }')
  assert.throws(() => parseScenario(source), /placement.repo/)
})
