import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { handoffFor, redactSecrets, redactValue } from './failover'
import type { Attempt, PipelineRun, PipelineTask } from './types'
import { checkpointFile } from './scenario'

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'unknown'
}

async function writeArtifact(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(redactValue(value), null, 2) + '\n'
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export type AttemptArtifactStore = {
  save(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<string>
  saveState?(run: PipelineRun, task: PipelineTask): Promise<void>
}

export class ArtifactStore {
  constructor(private readonly workspacePath: string) {}

  async saveCheckpoint(run: PipelineRun, stepId: string, body: string): Promise<string> {
    const relativePath = checkpointFile(run.runId, stepId)
    const directory = join(this.workspacePath, '.agent-pipeline', 'artifacts', safe(run.runId))
    await mkdir(directory, { recursive: true })
    const path = join(this.workspacePath, relativePath)
    await writeArtifact(path, { version: 1, runId: run.runId, stepId, body })
    return relativePath
  }

  async saveState(run: PipelineRun, task: PipelineTask): Promise<void> {
    const directory = join(this.workspacePath, '.agent-pipeline', 'artifacts', safe(run.runId))
    await mkdir(directory, { recursive: true })
    const path = join(directory, safe(task.stepId) + '.state.json')
    const state = { version: 1, runId: run.runId, stepId: task.stepId, revision: task.revision ?? 0, revisionPending: task.revisionPending, status: task.status, data: task.data, skipReason: task.skipReason, error: task.error, artifacts: task.attempts.map(attempt => attempt.artifactPath).filter(Boolean), history: task.history?.map(revision => ({ revision: revision.revision, taskId: revision.taskId, status: revision.status, artifacts: revision.attempts.map(attempt => attempt.artifactPath).filter(Boolean) })) }
    await writeArtifact(path, state)
  }

  async save(run: PipelineRun, task: PipelineTask, attempt: Attempt): Promise<string> {
    const directory = join(this.workspacePath, '.agent-pipeline', 'artifacts', safe(run.runId))
    await mkdir(directory, { recursive: true })
    const step = run.scenario.steps.find((candidate) => candidate.id === task.stepId)
    if (!step) throw new Error(`Шаг ${task.stepId} не найден для артефакта`)
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
      filesModifiedKnown: attempt.filesModified !== undefined,
      uncertainFiles: attempt.uncertainFiles ?? [],
      review: attempt.review,
      failure: attempt.failure,
      checks: attempt.checks ?? [],
      ...(attempt.data ? { data: attempt.data } : {}),
      reportPath: attempt.reportPath,
      output: redactSecrets((attempt.output ?? '').slice(-64_000)),
      handoff: handoffFor(step, task.attempts)
    }
    await writeArtifact(path, content)
    attempt.artifactPath = relative(this.workspacePath, path)
    return attempt.artifactPath
  }
}
