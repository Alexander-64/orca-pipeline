import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseScenario } from './scenario'
import type { Workspace } from './types'

const saving = new Set<string>()

function validName(name: string): boolean {
  return typeof name === 'string' && /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.ya?ml$/iu.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)
}

async function directory(workspace: Workspace, create = false): Promise<string> {
  if (workspace.hostId && workspace.hostId !== 'local') throw new Error('Repository files require a workspace on the coordinator host.')
  const path = join(await realpath(workspace.path), 'pipelines')
  if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(path)).isDirectory()) throw new Error('pipelines must be a directory inside the workspace.')
  return path
}

export async function listScenarios(workspace: Workspace): Promise<string[]> {
  try {
    const entries = await readdir(await directory(workspace), { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && validName(entry.name)).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readSource(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error('Select a regular YAML file.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error('Select a regular YAML file.')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

export async function openScenario(workspace: Workspace, name: string): Promise<string> {
  if (!validName(name)) throw new Error('Enter a YAML filename inside pipelines/.')
  return readSource(join(await directory(workspace), name))
}

export async function saveScenario(workspace: Workspace, name: string, source: string, previous: string | null): Promise<void> {
  if (!validName(name)) throw new Error('Enter a YAML filename inside pipelines/.')
  parseScenario(source)
  const folder = await directory(workspace, true)
  const path = join(folder, name)
  if (saving.has(path)) throw new Error('Another save is in progress.')
  saving.add(path)
  const temporary = join(folder, '.' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o600 })
    if (previous === null) {
      await link(temporary, path).catch(error => {
        if (error.code === 'EEXIST') throw new Error('This file already exists. Open it before saving changes.')
        throw error
      })
    } else {
      if (await readSource(path) !== previous) throw new Error('The file changed on disk. Reopen it before saving.')
      await chmod(temporary, (await lstat(path)).mode & 0o777)
      await rename(temporary, path)
    }
  } finally {
    saving.delete(path)
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
