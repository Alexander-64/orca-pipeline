import { assert, test } from 'orca/testing'
import { validateAcceptance, validateCommand } from './commands'
import { parseScenario } from './scenario'

test('allows ordinary test and inspection commands', () => {
  validateCommand('pnpm test')
  validateCommand('git status --short')
  validateCommand('pwd')
})

test('rejects destructive and network commands by default', () => {
  assert.throws(() => validateCommand('rm -rf dist'), /destructive/)
  assert.throws(() => validateCommand('git push origin main'), /destructive/)
  assert.throws(() => validateCommand('curl https://example.com'), /сетевая/)
})

test('enforces an explicit allowlist', () => {
  validateAcceptance(['pnpm test', 'pnpm lint'], { allowedCommands: ['pnpm'] })
  assert.throws(() => validateCommand('npm test', { allowedCommands: ['pnpm'] }), /allowlist/)
})

test('read-only mode permits inspection but not builds', () => {
  validateCommand('git diff --stat', { readOnly: true })
  validateCommand('pwd', { readOnly: true })
  assert.throws(() => validateCommand('pnpm test', { readOnly: true }), /read-only/)
})

test('rejects shell commands before a run is created', () => {
  assert.throws(() => parseScenario(`name: policy
objective: policy
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [rm -rf /]
`), /destructive/)
})

test('parses and applies a scenario command policy', () => {
  const scenario = parseScenario(`name: policy
objective: policy
commandPolicy:
  allowedCommands: [pwd, git diff]
  readOnly: true
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [pwd, git diff --stat]
`)
  assert.equal(scenario.commandPolicy?.readOnly, true)
  assert.throws(() => parseScenario(`name: policy
objective: policy
commandPolicy:
  allowedCommands: [pwd]
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    acceptance: [pnpm test]
`), /allowlist/)
})
