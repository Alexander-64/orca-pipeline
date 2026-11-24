import { readFile, realpath, stat } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ProjectResolver } from '../core/contracts'
import type { Project, Workspace } from '../core/types'
import { atomicJson } from '../runtime/files'
import { OrcaClient } from '../../src/cli'
import { projectOptions } from '../../src/projects'

export async function nativeProjects(client = new OrcaClient()): Promise<Project[]> {
  const [projects, repos] = await Promise.all([client.call(['project', 'list']), client.call(['repo', 'list'])])
  const rows = Array.isArray(repos.repos) ? repos.repos as Record<string, unknown>[] : []
  const workspaces: Workspace[] = rows.filter(row => typeof row.id === 'string' && typeof row.path === 'string' && (!row.hostId || row.hostId === 'local')).map(row => ({ id: `${row.id}::${row.path}`, path: String(row.path), name: String(row.displayName ?? basename(String(row.path))), kind: row.kind === 'folder' ? 'folder' : 'worktree', hostId: null, branch: null }))
  return projectOptions(projects, repos, workspaces)
}

export class SavedProjects implements ProjectResolver {
  constructor(readonly file = resolve(process.env.PIPELINE_PROJECTS_FILE || join(homedir(), '.agent-pipeline/projects.json')), private readonly native?: () => Promise<Project[]>) {}
  private async saved(): Promise<Project[]> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported saved projects format')
      return value.projects.filter((project: Project) => project && typeof project.path === 'string' && typeof project.id === 'string' && typeof project.name === 'string')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async list(): Promise<Project[]> {
    const saved = await this.saved(), native = this.native ? await this.native() : []
    const unique = new Map<string, Project>()
    for (const project of [...saved, ...native]) unique.set(project.path, project)
    return [...unique.values()]
  }
  async resolve(selector: string, snapshot?: readonly Project[]): Promise<Project> {
    if (!selector.trim()) throw new Error('Укажите номер, имя или путь проекта')
    const projects = snapshot ?? await this.list()
    const matches = projects.filter(project => project.id === selector || project.name === selector)
    if (matches.length > 1) throw new Error('Несколько проектов с таким именем; укажите ID или полный путь')
    const selected = /^[1-9]\d*$/.test(selector) ? projects[Number(selector) - 1] : matches[0]
    if (/^[1-9]\d*$/.test(selector) && !selected) throw new Error('Номер проекта отсутствует в списке')
    const path = await realpath(selected?.path ?? resolve(selector))
    if (!(await stat(path)).isDirectory()) throw new Error('Проект должен быть каталогом')
    return selected ? { ...selected, path } : { id: 'folder:' + path, workspaceId: 'folder:' + path, name: basename(path), path, kind: 'folder' }
  }
  async remember(project: Project): Promise<void> {
    const saved = await this.saved()
    await atomicJson(this.file, { version: 1, projects: [project, ...saved.filter(item => item.path !== project.path)].slice(0, 100) })
  }
}
