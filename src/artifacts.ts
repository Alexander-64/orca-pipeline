import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { handoffFor, redactSecrets } from './failover'
import type { Attempt, PipelineRun, PipelineTask } from './types'

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'unknown'
}

export type AttemptArtifactStore = {
  save(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<string>
}

export class ArtifactStore {
  constructor(private readonly workspacePath: string) {}

  async save(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<string> {
    const directory = join(this.workspacePath, '.agent-pipeline', 'artifacts', safe(run.runId))
    await mkdir(directory, { recursive: true })
    const step = run.scenario.steps.find((candidate) => candidate.id === task.stepId)
    if (!step) throw new Error(`Step ${task.stepId} was not found for the artifact`)
    const path = join(directory, `${safe(task.stepId)}-${safe(attempt.dispatchId)}.json`)
    const content = {
      version: 1,
      runId: run.runId,
      stepId: task.stepId,
      dispatchId: attempt.dispatchId,
      agent: attempt.agent,
      status: attempt.status,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      filesModified: attempt.filesModified ?? [],
      checks: attempt.checks ?? [],
      output: redactSecrets((attempt.output ?? '').slice(-64_000)),
      handoff: handoffFor(step, task.attempts)
    }
    await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
    attempt.artifactPath = relative(this.workspacePath, path)
    return attempt.artifactPath
  }
}
