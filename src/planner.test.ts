import { assert, test } from 'orca/testing'
import { extractTaskYaml, extractYaml } from './planner'

test('extracts and validates the last planner YAML block', () => {
  const source = extractYaml(`Рассуждения\n\n\`\`\`yaml
name: generated
objective: test
steps:
  - id: build
    title: Build
    spec: Work
    agent: codex
    fallback: [claude]
    placement: { host: local, worktree: current }
    acceptance: [pnpm test]
\`\`\``)
  assert.match(source, /name: generated/)
})

test('rejects prose or invalid YAML instead of starting it', () => {
  assert.throws(() => extractYaml('name: no-fence'), /fenced YAML/)
  assert.throws(() => extractYaml('```yaml\nname: broken\n```'), /steps/)
})

test('rejects an unclosed YAML fence even if its contents form a valid scenario', () => {
  const truncated = '```yaml\nname: test\nobjective: test\nsteps:\n  - id: work\n    title: Work\n    spec: Work\n    agent: codex\n    acceptance: [pwd]\n'
  assert.throws(() => extractYaml(truncated), /fenced YAML/)
  assert.equal(extractTaskYaml({ body: truncated }), undefined)
})

test('task result extraction safely ignores malformed, primitive and cyclic envelopes', () => {
  const cycle: Record<string, unknown> = {}
  cycle.result = cycle
  for (const result of [undefined, null, false, 42, 'null', '42', '{broken', [], { body: [] }, cycle]) {
    assert.equal(extractTaskYaml(result), undefined)
  }
})
