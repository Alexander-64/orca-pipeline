import { metricsForRuns } from './metrics'
import type { Dashboard, PipelineRun } from './types'

export const demoRun: PipelineRun = {
  id: 'local-1',
  runId: 'run_demo1',
  coordinatorHandle: 'term_demo',
  workspaceId: 'workspace-1',
  workspacePath: '/tmp/demo',
  scenario: {
    name: 'demo-pipeline',
    objective: 'Проверить pipeline',
    steps: [{
      id: 'build',
      title: 'Реализация',
      spec: 'Внести изменение и запустить проверки',
      needs: [],
      agent: 'codex',
      fallback: ['claude'],
      placement: { host: 'local', worktree: 'current' },
      acceptance: ['npm test'],
      maxAttempts: 3,
      maxRepairs: 2
    }]
  },
  status: 'running',
  tasks: {
    build: {
      stepId: 'build',
      taskId: 'task_demo1',
      beadId: 'bd-demo1',
      status: 'running',
      agent: 'codex',
      attempts: [{
        dispatchId: 'dispatch_demo1',
        agent: 'codex',
        status: 'running',
        startedAt: '2026-11-10T12:00:00.000Z',
        output: 'Выполняются проверки…'
      }]
    }
  },
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z'
}

export const demoDashboard: Dashboard = {
  runs: [],
  beads: [{ id: 'bd-demo1', title: 'Реализация', status: 'in_progress', priority: 2, issueType: 'task' }],
  workspaces: [{ id: 'workspace-1', kind: 'worktree', name: 'Demo', path: '/tmp/demo', branch: 'main', hostId: null }],
  metrics: metricsForRuns([])
}

// Fork and join fixture for the visual editor's responsive check scenarios.
export const parallelDraft = `name: parallel-demo
objective: Fork and join
steps:
  - id: research
    title: Research
    spec: Explore requirements
    agent: codex
    fallback: [claude]
    acceptance: [npm test]
  - id: design
    title: Design
    spec: Explore interface
    agent: claude
    needs: []
    reviewAgent: codex
    acceptance: [npm test]
  - id: build
    title: Build
    spec: Combine findings
    agent: codex
    needs: [research, design]
    approval: Confirm implementation
    placement:
      host: remote-demo
      worktree: 'id:workspace-demo'
    acceptance: [npm test]
`

// Deliberately shuffled: the monitor must follow dependencies, not source order.
export const dependencyRun: PipelineRun = (() => {
  const run = structuredClone(demoRun)
  const base = run.scenario.steps[0]
  run.scenario.steps = [
    { ...base, id: 'join', title: 'Собрать результаты исследования и проверки контракта', needs: ['research', 'contract'] },
    { ...base, id: 'research', title: 'Исследовать процесс, маршруты и роли SDD', needs: [] },
    { ...base, id: 'contract', title: 'Проверить машинный контракт и требования к результату', needs: [] },
    { ...base, id: 'independent', title: 'Независимая ветка', needs: [] },
    { ...base, id: 'review', title: 'Финальная проверка', needs: ['join'], join: 'all_settled' }
  ]
  run.tasks = Object.fromEntries(run.scenario.steps.map(step => [step.id, {
    stepId: step.id, taskId: `task_${step.id}`, agent: step.agent,
    status: step.id === 'research' ? 'done' : step.id === 'contract' ? 'failed' : step.id === 'independent' ? 'running' : 'blocked', attempts: []
  }]))
  return run
})()
