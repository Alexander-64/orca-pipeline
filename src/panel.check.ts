import { simulateFailover } from '../examples/failover/simulation'
import { fixtureWorkspace } from './coordinatorFixture'
import { metricsForRuns } from './metrics'
import { defineCheck } from 'orca/testing'
import { demoDashboard, demoRun, dependencyRun, parallelDraft } from './testData'

const recoveryRun = structuredClone(demoRun)
recoveryRun.status = 'paused'
recoveryRun.tasks.build.unconfirmedStart = true
recoveryRun.tasks.build.error = 'Agent claude is disabled. Choose an enabled agent.'

const documentationRun = structuredClone(demoRun)
documentationRun.scenario.name = 'Documentation review'
documentationRun.scenario.objective = 'Check the installation guide before shipping.'
documentationRun.scenario.steps[0].title = 'Verify documentation links'
documentationRun.status = 'failed'
const linkTask = documentationRun.tasks.build
linkTask.status = 'failed'
Object.assign(linkTask.attempts[0], {
  status: 'failed', output: 'README.md:42 links to docs/install.md, which was moved to docs/setup.md.',
  checks: [{ command: 'npm run check:links', exitCode: 1 }]
})

export default defineCheck({
  documentationResult: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [documentationRun] }) },
    persisted: { plugin: { 'pipeline.tab': 'result', 'pipeline.run-mode': 'existing', 'pipeline.run': documentationRun.id } }
  },
  recoveryUx: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [recoveryRun], recoveryWarning: 'Resource operation has an unconfirmed receipt' }) },
    persisted: { plugin: { 'pipeline.run-mode': 'existing', 'pipeline.run': recoveryRun.id, 'pipeline.stage': 'monitor' } }
  },
  split: {
    requests: { 'dashboard.get': () => demoDashboard },
    persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.draft': parallelDraft, 'pipeline.editor-view': 'split' } }
  },
  parallel: {
    requests: { 'dashboard.get': () => demoDashboard },
    persisted: { plugin: { 'pipeline.stage': 'steps', 'pipeline.draft': parallelDraft } }
  },
  launch: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [] }) },
    persisted: { plugin: { 'pipeline.stage': 'monitor' } }
  },
  russian: {
    settings: { interfaceLanguage: 'ru' },
    requests: { 'dashboard.get': () => demoDashboard }
  },
  empty: {
    requests: {
      'dashboard.get': () => demoDashboard
    }
  },
  dependencies: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [dependencyRun] }) },
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': dependencyRun.id, 'pipeline.step': 'join' } }
  },
  running: {
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun] })
    },
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': demoRun.id, 'pipeline.step': 'build' } }
  },
  models: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, modelCatalogs: {
      codex: { observedAt: 1794850314604, models: [{ id: 'observed-model', label: 'Модель из каталога', efforts: [{ value: 'high', label: 'High' }] }] }
    } }) },
    persisted: { plugin: { 'pipeline.run-mode': 'new', 'pipeline.stage': 'steps', 'pipeline.editor-view': 'split' } }
  },
  storedParameters: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [dependencyRun] }) },
    persisted: { plugin: { 'pipeline.run-mode': 'existing', 'pipeline.run': dependencyRun.id, 'pipeline.stage': 'steps' } }
  },
  result: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [dependencyRun] }) },
    persisted: { plugin: { 'pipeline.tab': 'result', 'pipeline.run-mode': 'existing', 'pipeline.run': dependencyRun.id } }
  },
  tasks: {
    requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [dependencyRun], beads: [], beadsEnabled: false }) },
    persisted: { plugin: { 'pipeline.tab': 'beads' } }
  },
  failover: {
    requests: {
      'dashboard.get': async () => {
        const { run } = await simulateFailover()
        return JSON.parse(JSON.stringify({
          ...demoDashboard, workspaces: [fixtureWorkspace], runs: [run], metrics: metricsForRuns([run])
        }))
      }
    },
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.step': 'build' } }
  },
  beads: {
    requests: {
      'dashboard.get': () => demoDashboard
    },
    persisted: { plugin: { 'pipeline.tab': 'beads' } }
  },
  beadsUnavailable: {
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, beads: [], beadsError: 'bd: command not found' })
    },
    persisted: { plugin: { 'pipeline.tab': 'beads' } }
  }
})
