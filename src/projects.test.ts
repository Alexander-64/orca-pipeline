import { assert, test } from 'orca/testing'
import { projectOptions } from './projects'
import type { Workspace } from './types'

test('project selection resolves registered project root rather than an unrelated similarly named worktree', () => {
  const root: Workspace = { id: 'repo::/jarvis', name: 'jarvis', path: '/jarvis', kind: 'folder', branch: null, hostId: 'local' }
  const unrelated = { ...root, id: 'identity:other', name: 'Джарвис', path: '/other/Джарвис', kind: 'worktree' as const }
  const projects = projectOptions({ projects: [{ id: 'project', displayName: 'jarvis', sourceRepoIds: ['repo'] }] }, { repos: [{ id: 'repo', path: '/jarvis', displayName: 'jarvis' }] }, [unrelated, root])
  assert.deepEqual(projects, [{ id: 'project', name: 'jarvis', path: '/jarvis', workspaceId: root.id, kind: 'folder' }])
})
