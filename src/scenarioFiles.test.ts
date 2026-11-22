import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { DEFAULT_SCENARIO } from './types'

test('workspace file requests round-trip YAML and protect edits on disk', async () => {
  const path = await mkdtemp(join(tmpdir(), 'pipeline-files-'))
  const input = { workspaceId: 'w', name: 'scenario.yaml' }
  const workspace = { id: 'w', name: 'test', kind: 'folder' as const, path, branch: null, hostId: 'local' }
  const worker = await mountWorker(main, { host: mockHost({ results: {
    'workspace.list': { workspaces: [workspace, { ...workspace, id: 'remote', hostId: 'ssh:server' }], truncated: false }
  } }) })
  try {
    assert.deepEqual((await worker.request('scenario.files', input)).names, [])
    const save = (source: string, previous: string | null, name = input.name) => worker.request('scenario.save', { ...input, name, previous, source })
    await save(DEFAULT_SCENARIO, null)
    assert.deepEqual((await worker.request('scenario.files', input)).names, [input.name])
    const { source } = await worker.request('scenario.open', input)
    assert.equal(source, DEFAULT_SCENARIO)
    await assert.rejects(() => save(source, null), /already exists/)
    await assert.rejects(() => save(source, null, '../file.yaml'), /filename/)
    await assert.rejects(() => worker.request('scenario.files', { workspaceId: 'remote' }), /coordinator host/)
    const updated = '# Stored comment\n' + source
    await save(updated, source)
    await assert.rejects(() => save(source, source), /changed on disk/)
    assert.equal(await readFile(join(path, 'pipelines', input.name), 'utf8'), updated)
    await writeFile(join(path, 'outside.yaml'), source)
    await symlink(join(path, 'outside.yaml'), join(path, 'pipelines/link.yaml'))
    await assert.rejects(() => worker.request('scenario.open', { ...input, name: 'link.yaml' }), /regular YAML/)
  } finally {
    await worker.deactivate()
    await rm(path, { recursive: true, force: true })
  }
})
