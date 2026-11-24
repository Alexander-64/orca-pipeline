import type { Project, Workspace } from './types'

const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
export function projectOptions(projectsResult: unknown, reposResult: unknown, workspaces: Workspace[]): Project[] {
  const repos = Array.isArray(row(reposResult).repos) ? row(reposResult).repos as Record<string, unknown>[] : []
  const projects = Array.isArray(row(projectsResult).projects) ? row(projectsResult).projects as Record<string, unknown>[] : []
  return projects.flatMap(project => {
    const ids = Array.isArray(project.sourceRepoIds) ? project.sourceRepoIds : []
    const repo = repos.find(repo => ids.includes(repo.id))
    if (!repo || typeof repo.path !== 'string' || typeof project.id !== 'string') return []
    const candidates = workspaces.filter(workspace => workspace.path === repo.path || ids.some(id => workspace.id.startsWith(`${id}::`)))
    const workspace = candidates.find(workspace => workspace.path === repo.path) ?? candidates[0]
    return workspace ? [{ id: project.id, name: String(project.displayName ?? repo.displayName), path: repo.path, workspaceId: workspace.id, kind: workspace.kind }] : []
  })
}
