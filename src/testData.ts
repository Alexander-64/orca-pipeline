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
    objective: 'Verify the pipeline',
    steps: [{
      id: 'build',
      title: 'Implementation',
      spec: 'Make the change and run the checks',
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
        output: 'Running checks…'
      }]
    }
  },
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z'
}

export const demoDashboard: Dashboard = {
  runs: [],
  beads: [{ id: 'bd-demo1', title: 'Implementation', status: 'in_progress', priority: 2, issueType: 'task' }],
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
