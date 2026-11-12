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
