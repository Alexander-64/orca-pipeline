import { DEFAULT_SCENARIO } from './types'
import type { Language } from './i18n'

export const SCENARIO_TEMPLATES: Record<string, string> = {
  'implement-review': `name: implement-review
objective: Реализовать изменение и независимо проверить результат
steps:
  - id: implement
    title: Реализация
    spec: Внести требуемое изменение и выполнить проверки
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'bugfix-regression': `name: bugfix-regression
objective: Исправить ошибку и закрепить её регрессионным тестом
steps:
  - id: reproduce
    title: Воспроизведение
    spec: Добавить минимальный failing regression test
    agent: codex
    acceptance: [pnpm test]
  - id: fix
    title: Исправление
    needs: [reproduce]
    spec: Исправить причину ошибки, не меняя тест на более слабый
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'research-design': `name: research-design
objective: Исследовать задачу, согласовать дизайн и реализовать его
steps:
  - id: research
    title: Исследование
    spec: Изучить код и сформулировать варианты решения с trade-offs
    agent: kimi
    acceptance: [git status]
  - id: implement
    title: Реализация по дизайну
    needs: [research]
    spec: Реализовать выбранный вариант и проверить результат
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`
}

const englishTemplates: Record<string, string> = {
  'implement-review': `name: implement-review
objective: Implement the change and independently review the result
steps:
  - id: implement
    title: Implementation
    spec: Implement the requested change and run the checks
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'bugfix-regression': `name: bugfix-regression
objective: Fix a bug and cover it with a regression test
steps:
  - id: reproduce
    title: Reproduce the bug
    spec: Add a minimal failing regression test
    agent: codex
    acceptance: [pnpm test]
  - id: fix
    title: Fix
    needs: [reproduce]
    spec: Fix the underlying issue and retain the regression test
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`,
  'research-design': `name: research-design
objective: Research the problem, agree on a design and implement it
steps:
  - id: research
    title: Research
    spec: Inspect the code and compare alternatives and trade-offs
    agent: kimi
    acceptance: [git status]
  - id: implement
    title: Implement the design
    needs: [research]
    spec: Implement the selected design and verify the result
    agent: codex
    fallback: [opencode, kimi]
    reviewAgent: claude
    acceptance: [pnpm test]
`
}

const englishDefault = `name: demo-pipeline
objective: Make a small change and independently verify the result
steps:
  - id: implement
    title: Implementation
    spec: |
      Describe the task, its scope and the expected result.
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
  - id: review
    title: Independent review
    needs: [implement]
    spec: |
      Review the preceding result, run the checks and report any issues.
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - "pnpm test"
`

export const defaultScenario = (language: Language) => language === 'ru' ? DEFAULT_SCENARIO : englishDefault
export const scenarioTemplate = (id: string, language: Language) => (language === 'ru' ? SCENARIO_TEMPLATES : englishTemplates)[id]
