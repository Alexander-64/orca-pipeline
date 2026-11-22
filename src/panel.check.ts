import { defineCheck } from 'orca/testing'
import { simulateFailover } from '../examples/failover/simulation'
import { fixtureWorkspace } from './coordinatorFixture'
import { metricsForRuns } from './metrics'
import { demoDashboard, demoRun, parallelDraft } from './testData'

export default defineCheck({
  split: {
    requests: { 'dashboard.get': () => demoDashboard },
    persisted: { plugin: { 'pipeline.draft': parallelDraft, 'pipeline.editor-view': 'split' } }
  },
  parallel: {
    requests: { 'dashboard.get': () => demoDashboard },
    persisted: { plugin: { 'pipeline.draft': parallelDraft } }
  },
  empty: {
    requests: {
      'dashboard.get': () => demoDashboard
    }
  },
  running: {
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun] })
    },
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': demoRun.id, 'pipeline.step': 'build' } }
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
