import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createCopy, gitAdmin, reviewChanges } from '../runtime/worktree-review'
import type { PipelineRun } from '../core/types'
import type { RuntimeConfig } from '../runtime/config'

type Registration = { base: string; copy: string; requestId: string; planHash: string }
function registry(source: string, copy: string) {
  const key = createHash('sha256').update(copy).digest('hex')
  return join(gitAdmin(source), 'agent-pipeline-copies', key + '.json')
}

export async function prepareIsolated(source: string, destination: string, yaml: string, requestId: string, config: RuntimeConfig) {
  const copy = resolve(await realpath(dirname(destination)), basename(destination))
  const inside = relative(source, copy)
  if (!inside || !(inside === '..' || inside.startsWith('..' + sep))) throw new Error('Choose a new worktree outside the source project')
  const file = registry(source, copy)
  const planHash = createHash('sha256').update(yaml).digest('hex')
  let prior: Registration | undefined
  try { prior = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (prior) {
    if (prior.requestId !== requestId || prior.planHash !== planHash) throw new Error('Worktree already belongs to another run. Choose a new directory.')
    return realpath(prior.copy)
  }
  const base = createCopy(source, copy)
  const configDir = join(copy, '.agent-pipeline')
  // Refuse to follow a tracked symlink into another project for runtime files.
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  if (await realpath(configDir) !== configDir) throw new Error('Unsafe runtime directory in isolated copy')
  const temp = join(configDir, 'config-' + randomUUID() + '.tmp')
  await writeFile(temp, JSON.stringify({ ...config, backend: 'local' }), { flag: 'wx', mode: 0o600 })
  await rename(temp, join(configDir, 'config.json'))
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify({ base, copy, requestId, planHash }), { flag: 'wx', mode: 0o600 })
  return copy
}

export async function isolatedChanges(source: string, copy: string, run: PipelineRun, digest?: string) {
  const root = await realpath(copy)
  const record: Registration = JSON.parse(await readFile(registry(source, root), 'utf8'))
  if (run.status !== 'done' || await realpath(run.workspacePath) !== root) throw new Error('A completed run in this isolated copy is required')
  const bound = await readFile(registry(source, root) + '.run', 'utf8')
  if (run.id !== bound) throw new Error('Run does not own this worktree')
  return reviewChanges(source, root, record.base, digest)
}

export async function bindIsolated(source: string, copy: string, id: string) {
  const file = registry(source, copy) + '.run'
  try { await writeFile(file, id, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== id) throw error }
}
