import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SavedProjects, nativeProjects } from './projects'
import { OrcaClient } from '../../src/cli'

test('saved projects resolve names, paths and the displayed numeric snapshot without switching targets on refresh', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-projects-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'one'), b = join(root, 'two'); await mkdir(a); await mkdir(b)
  const first = { id: 'one', name: 'First', path: a, workspaceId: 'one', kind: 'folder' as const }
  const second = { id: 'two', name: 'Second', path: b, workspaceId: 'two', kind: 'folder' as const }
  let rows = [first, second]
  const registry = new SavedProjects(join(root, 'projects.json'), async () => rows)
  const snapshot = await registry.list(); rows = [second, first]
  assert.equal((await registry.resolve('1', snapshot)).path, a)
  assert.equal((await registry.resolve('First')).path, a)
  await registry.remember(first)
  assert.equal((await new SavedProjects(registry.file).resolve('one')).path, a)
  const alias = join(root, 'alias'); await symlink(a, alias)
  assert.equal((await registry.resolve(alias)).path, a)
  await assert.rejects(registry.resolve('3'), /Номер/)
  await assert.rejects(registry.resolve(''), /Укажите/)
  rows = [first, { ...second, name: first.name }]
  await assert.rejects(registry.resolve('First'), /Несколько/)
  await writeFile(registry.file, JSON.stringify({ version: 99, projects: [] }))
  await assert.rejects(registry.list(), /Unsupported/)
})

test('Orca project discovery includes exact local repository roots and excludes remote repos', async () => {
  const client = new OrcaClient(async (_file, args) => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: args[0] === 'project' ? { projects: [{ id: 'p1', displayName: 'Jarvis', sourceRepoIds: ['r1'] }, { id: 'p2', displayName: 'Remote', sourceRepoIds: ['r2'] }] } : { repos: [{ id: 'r1', path: '/projects/jarvis', kind: 'folder' }, { id: 'r2', path: '/remote/jarvis', hostId: 'remote' }] } }) }))
  const projects = await nativeProjects(client)
  assert.equal(projects.length, 1); assert.equal(projects[0].name, 'Jarvis'); assert.equal(projects[0].path, '/projects/jarvis')
})
