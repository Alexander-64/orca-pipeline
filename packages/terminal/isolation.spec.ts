import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCopy, reviewChanges } from '../runtime/worktree-review'

function repo(t: { after(f: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-review-')), source = join(dir, 'source'), copy = join(dir, 'copy')
  mkdirSync(source)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q'); writeFileSync(join(source, 'README'), 'before\n'); git('add', 'README')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'base')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { source, copy, git }
}

test('reviews tracked and new text and refuses stale, conflicting, duplicate and binary acceptance', t => {
  const { source, copy, git } = repo(t), base = createCopy(source, copy)
  writeFileSync(join(copy, 'README'), 'after\n')
  writeFileSync(join(copy, 'new file'), 'first\n')
  mkdirSync(join(copy, '.agent-pipeline')); writeFileSync(join(copy, '.agent-pipeline/log'), 'private')
  const initial = reviewChanges(source, copy, base)
  assert.deepEqual(initial.files, ['README', 'new file'])
  assert.equal(readFileSync(join(source, 'README'), 'utf8'), 'before\n')
  writeFileSync(join(copy, 'new file'), 'latest\n')
  assert.throws(() => reviewChanges(source, copy, base, initial.digest), /changed/)
  const current = reviewChanges(source, copy, base)
  writeFileSync(join(source, 'README'), 'local edit\n')
  assert.throws(() => reviewChanges(source, copy, base, current.digest), /already have changes/)
  assert.equal(readFileSync(join(source, 'README'), 'utf8'), 'local edit\n')
  git('restore', '--', 'README')
  writeFileSync(join(source, 'unrelated'), 'preserve\n')
  reviewChanges(source, copy, base, current.digest)
  assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n'), ['README', 'new file'])
  assert.equal(readFileSync(join(source, 'new file'), 'utf8'), 'latest\n')
  assert.throws(() => reviewChanges(source, copy, base, current.digest), /already have changes/)
  writeFileSync(join(copy, 'binary'), Buffer.from([0,1,2]))
  assert.throws(() => reviewChanges(source, copy, base), /text patches only/)
})

test('installed console commands run in a detached copy then review and stage the exact result', async t => {
  const { source, copy, git } = repo(t)
  const cli = fileURLToPath(new URL('../../dist/terminal/cli.mjs', import.meta.url))
  const executor = fileURLToPath(new URL('../runtime/fixtures/review-executor.mjs', import.meta.url))
  const exec = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 40000 })
  mkdirSync(join(source, '.agent-pipeline'))
  writeFileSync(join(source, '.agent-pipeline/config.json'), JSON.stringify({ executors: { fixture: { kind: 'jsonl', executable: process.execPath, args: [executor] } } }))
  writeFileSync(join(source, 'scenario.yaml'), 'name: review\nobjective: Write candidate\nsteps:\n - {id: author, title: Author, spec: Write report, agent: fixture, acceptance: [pwd]}\n')
  try {
    exec('run', '-C', source, '--isolated', copy, '-f', 'scenario.yaml', '--watch')
    const run = JSON.parse(exec('status', '-C', copy, '--json')).runs[0]
    assert.equal(run.workspacePath, await realpath(copy)); assert.equal(run.status, 'done')
    const args = ['-C', source, '--isolated', copy, '--run', run.id, '--json']
    const diff = JSON.parse(exec('diff', ...args))
    assert.deepEqual(diff.files, ['report.txt'])
    assert.equal(git('diff', '--cached'), '')
    assert.throws(() => exec('accept', ...args, '--digest', 'wrong'))
    exec('accept', ...args, '--digest', diff.digest)
    assert.equal(git('show', ':report.txt'), 'DRAFT\n')
  } finally { try { exec('shutdown', '-C', copy) } catch {} }
})
