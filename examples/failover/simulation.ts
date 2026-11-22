import { coordinatorFixture, fixtureWorkspace } from '../../src/coordinatorFixture'
import { parseScenario } from '../../src/scenario'

export async function simulateFailover() {
  const scenario = parseScenario(`name: Simulated quota failover
objective: Recover a release notes edit and verify it independently
steps:
  - id: build
    title: Update release notes
    spec: Summarize the change in CHANGELOG.md
    agent: codex
    fallback: [claude]
    reviewAgent: kimi
    acceptance: [git diff --check]
  - id: prepare
    title: Prepare release summary
    spec: Summarize the verified changes for the release owner
    agent: codex
    needs: [build]
    acceptance: [git diff --check]
`)
  const host = coordinatorFixture()
  const run = await host.coordinator.start(fixtureWorkspace, 'term_demo', scenario)

  // Simulate a live quota error after the primary agent's turn has ended.
  host.state.output = 'Usage limit reached. Partial draft saved in CHANGELOG.md.'
  host.state.activityDone = true
  await host.coordinator.tick(run.id)
  const resumed = structuredClone(run)
  const startsAfterFailover = structuredClone(host.starts)

  host.state.output = 'Release notes updated. git diff --check passed.'
  host.statuses.set('task_build', 'completed')
  await host.coordinator.tick(run.id)
  const startsDuringReview = structuredClone(host.starts)

  host.state.output = 'SHIP: reviewed CHANGELOG.md and verified git diff --check.'
  host.statuses.set('task_build-evidence', 'completed')
  await host.coordinator.tick(run.id)

  host.state.output = 'Release summary prepared.'
  host.statuses.set('task_prepare', 'completed')
  await host.coordinator.tick(run.id)

  return {
    run,
    resumed,
    startsAfterFailover,
    startsDuringReview,
    starts: host.starts,
    stops: host.stops,
    checkpoint: host.handoffs[0]
  }
}
