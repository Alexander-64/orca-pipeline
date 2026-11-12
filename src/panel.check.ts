import { defineCheck } from 'orca/testing'
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
