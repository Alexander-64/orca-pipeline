import { assert, test } from 'orca/testing'
import { classifyFailure, handoffFor, nextAgent } from './failover'
import { parseScenario } from './scenario'
import type { Attempt } from './types'

const source = `name: test
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude, kimi]
    acceptance: [test]
`

test('classifies provider failures without conflating them', () => {
  assert.equal(classifyFailure('You have reached your usage limit'), 'quota')
  assert.equal(classifyFailure('HTTP 429 insufficient_quota'), 'quota')
  assert.equal(classifyFailure('401 unauthorized'), 'auth')
  assert.equal(classifyFailure('connection reset'), 'network')
  assert.equal(classifyFailure('tests failed'), 'unknown')
})

test('selects each fallback once and carries the checkpoint', () => {
  const step = parseScenario(source).steps[0]
  const attempts: Attempt[] = [
    { dispatchId: 'd1', agent: 'codex', status: 'failed' as const, startedAt: 'now', output: 'partial diff and usage limit' }
  ]
  assert.equal(nextAgent(step, attempts), 'claude')
  attempts.push({ dispatchId: 'd2', agent: 'claude', status: 'failed', startedAt: 'later' })
  assert.equal(nextAgent(step, attempts), 'kimi')
  assert.match(handoffFor(step, attempts), /partial diff and usage limit/)
  assert.match(handoffFor(step, attempts), /не начинай задачу заново/i)
})
