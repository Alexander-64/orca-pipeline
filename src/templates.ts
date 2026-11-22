export const SCENARIO_TEMPLATES: Record<string, string> = {
  'implement-review': `name: implement-review
objective: Implement a change and have an independent reviewer verify it
steps:
  - id: implement
    title: Implementation
    spec: Make the requested change and run the checks
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'bugfix-regression': `name: bugfix-regression
objective: Fix the bug and cover it with a regression test
steps:
  - id: reproduce
    title: Reproduce the bug
    spec: Add a minimal regression test that fails
    agent: codex
    acceptance: [pnpm test]
  - id: fix
    title: Fix the bug
    needs: [reproduce]
    spec: Fix the cause of the bug and keep the regression test intact
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'research-design': `name: research-design
objective: Investigate the task, agree on a design and implement it
steps:
  - id: research
    title: Investigate
    spec: Review the code and describe the options and trade-offs
    agent: kimi
    acceptance: [git status]
  - id: implement
    title: Implement the design
    needs: [research]
    spec: Implement the chosen design and verify the result
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`
}
