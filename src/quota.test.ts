import { assert, test } from 'orca/testing'
import { coordinatorFixture, fixtureWorkspace } from './coordinatorFixture'
import { chooseAvailableAgent, usageIsExhausted, type UsageWindow } from './quota'
import { mapCodexRateLimits } from './usage'
import { parseScenario } from './scenario'

const now = 2_000_000
const step = parseScenario(`name: quota
objective: quota
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude, kimi]
    acceptance: [test]
`).steps[0]

function window(usedPercent: number, overrides: Partial<UsageWindow> = {}): UsageWindow {
  return { id: 'primary', usedPercent, observedAt: now - 1_000, ...overrides }
}

test('skips an exhausted primary agent', () => {
  const selected = chooseAvailableAgent(step, [], { codex: [window(100)], claude: [window(20)], kimi: [] }, now)
  assert.equal(selected.agent, 'claude')
})

test('ignores a full window whose reset has already passed', () => {
  assert.equal(usageIsExhausted([window(100, { resetsAt: now - 1 })], now, 95), false)
})

test('fresh high usage blocks while stale healthy data does not', () => {
  assert.equal(usageIsExhausted([window(96)], now, 95), true)
  assert.equal(usageIsExhausted([window(20, { observedAt: now - 400_000 })], now, 95), false)
})

test('any active binding window can exhaust an account', () => {
  const windows = [window(10), { ...window(98), id: 'monthly' }]
  assert.equal(usageIsExhausted(windows, now, 95), true)
})

test('missing usage data preserves the configured chain', () => {
  assert.equal(chooseAvailableAgent(step, [], {}, now).agent, 'codex')
})

test('maps Codex primary and secondary rate-limit windows', () => {
  const windows = mapCodexRateLimits({
    result: {
      rateLimits: {
        primary: { usedPercent: 70, resetsAt: 3_000 },
        secondary: { usedPercent: 20, resetsAt: 4_000 }
      }
    }
  }, now)
  assert.equal(windows.length, 2)
  assert.equal(windows[0].resetsAt, 3_000_000)
})

test('coordinator uses live quota data for initial agent selection', async () => {
  const h = coordinatorFixture({
    usage: {
      read: async (agent) => agent === 'codex' ? [window(100)] : [window(5)]
    }
  })
  await h.coordinator.start(fixtureWorkspace, 'term_1', parseScenario(`name: quota
objective: quota
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude]
    acceptance: [test]
`))
  assert.equal(h.starts[0].agent, 'claude')
})
