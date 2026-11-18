import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { cp, mkdir, writeFile, mkdtemp, readFile, readdir, lstat, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildRelease, root } from './build-release.mjs'

const exec = promisify(execFile)
const yamlRoundTrip = "import {parse,stringify} from './vendor/yaml/index.js'; import assert from 'node:assert/strict'; assert.deepEqual(parse(stringify({steps:[1]})),{steps:[1]})"

// A working-tree copy hides ignored or untracked dependencies. Reconstruct only
// Git's inventory, including staged additions, without installing dependencies.
async function copyGitFiles(projectRoot, destination) {
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: projectRoot })
  for (const name of stdout.split('\0').filter(Boolean)) {
    const target = path.join(destination, name)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(path.join(projectRoot, name), target)
  }
}

test('Git source inventory builds a release with a working YAML runtime', async t => {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'release-git-source-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'source')
  await copyGitFiles(root, source)
  const result = await buildRelease(path.join(temp, 'release'), { projectRoot: source })
  await exec(process.execPath, ['--input-type=module', '-e', yamlRoundTrip], { cwd: result.output })
})

test('Git inventory exposes ignored YAML dependencies even when local import works', async t => {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'release-ignored-runtime-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await cp(path.join(root, 'vendor'), path.join(source, 'vendor'), { recursive: true })
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}\n')
  await writeFile(path.join(source, '.gitignore'), 'dist/\n')
  await exec('git', ['init', '--quiet'], { cwd: source })
  await exec('git', ['add', '.'], { cwd: source })
  await exec(process.execPath, ['--input-type=module', '-e', yamlRoundTrip], { cwd: source })
  const snapshot = path.join(temp, 'snapshot')
  await copyGitFiles(source, snapshot)
  await assert.rejects(
    exec(process.execPath, ['--input-type=module', '-e', yamlRoundTrip], { cwd: snapshot }),
    error => /ERR_MODULE_NOT_FOUND/.test(error.stderr) && /vendor\/yaml\/dist\/index.js/.test(error.stderr),
  )
})

test('release is complete, byte-identical, source-only and does not overwrite', async () => {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'agent-pipeline-release-'))
  try {
    const result = await buildRelease(path.join(temp, 'release'))
    assert.ok(result.files.includes('vendor/yaml/LICENSE'))
    assert.equal(result.licenseIncluded, true)
    for (const name of ['README.md', 'README.en.md', 'README.zh-CN.md', 'src/worker.ts', 'src/panel.tsx']) assert.ok(result.files.includes(name))
    const actual = await readdir(result.output, { recursive: true })
    const files = []
    for (const name of actual) {
      const stat = await lstat(path.join(result.output, name))
      assert.equal(stat.isSymbolicLink(), false)
      if (stat.isFile()) files.push(name)
    }
    assert.deepEqual(files.sort(), result.files.slice().sort())
    for (const name of result.files) {
      assert.doesNotMatch(name, /(?:\.test\.|\.check\.|Fixture|testData|node_modules|\.orca|\.agent-pipeline|\.env|\.log|\.map|\.zip)/)
      assert.deepEqual(await readFile(path.join(result.output, name)), await readFile(path.join(root, name)))
    }
    await assert.rejects(buildRelease(result.output), /already exists/)
    await symlink(result.output, path.join(temp, 'link'))
    await assert.rejects(buildRelease(path.join(temp, 'link', 'nested')), /symlink/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'release-fixture-'))
  t.after(() => rm(projectRoot, { recursive: true, force: true }))
  for (const name of ['src', 'vendor', 'orca-plugin.json', 'README.md', 'README.en.md', 'README.zh-CN.md', 'LICENSE']) {
    await cp(path.join(root, name), path.join(projectRoot, name), { recursive: true })
  }
  return projectRoot
}

test('two default builds replace changed files and remove stale/dev files in isolation', async t => {
  const projectRoot = await fixture(t)
  const first = await buildRelease(undefined, { projectRoot })
  await writeFile(path.join(projectRoot, 'README.md'), 'Fresh release documentation\n')
  await writeFile(path.join(first.output, 'stale.txt'), 'old')
  await mkdir(path.join(first.output, 'node_modules'))
  await writeFile(path.join(first.output, 'node_modules', 'dev.js'), 'dev only')
  await writeFile(path.join(first.output, 'src', 'worker.test.ts'), 'dev only')
  const second = await buildRelease(undefined, { projectRoot })
  assert.equal(second.output, first.output)
  assert.equal(await readFile(path.join(second.output, 'README.md'), 'utf8'), 'Fresh release documentation\n')
  for (const name of ['stale.txt', 'node_modules', 'src/worker.test.ts']) {
    await assert.rejects(lstat(path.join(second.output, name)), { code: 'ENOENT' })
  }
  assert.deepEqual(await readdir(path.join(projectRoot, 'dist')), ['agent-pipeline'])
})

test('custom existing output remains untouched', async t => {
  const projectRoot = await fixture(t)
  const output = path.join(projectRoot, 'custom')
  await mkdir(output)
  await writeFile(path.join(output, 'keep'), 'user data')
  await assert.rejects(buildRelease(output, { projectRoot }), /already exists/)
  assert.equal(await readFile(path.join(output, 'keep'), 'utf8'), 'user data')
  assert.deepEqual(await readdir(output), ['keep'])
})

for (const phase of ['write', 'publish']) {
  test(`failed ${phase} preserves old release and cleans staging`, async t => {
    const projectRoot = await fixture(t)
    const first = await buildRelease(undefined, { projectRoot })
    await writeFile(path.join(first.output, 'keep'), 'old release')
    const io = {
      ...fs,
      async writeFile(...args) {
        if (phase === 'write') throw new Error('injected write failure')
        return fs.writeFile(...args)
      },
      async rename(from, to) {
        if (phase === 'publish' && path.basename(from) === 'fresh') throw new Error('injected publish failure')
        return fs.rename(from, to)
      },
    }
    await assert.rejects(buildRelease(undefined, { projectRoot, io }), /injected/)
    assert.equal(await readFile(path.join(first.output, 'keep'), 'utf8'), 'old release')
    assert.deepEqual(await readdir(path.join(projectRoot, 'dist')), ['agent-pipeline'])
  })
}

test('default output symlink and symlink parent cannot redirect replacement', async t => {
  const projectRoot = await fixture(t)
  const outside = path.join(projectRoot, 'keep')
  await mkdir(outside)
  await mkdir(path.join(projectRoot, 'dist'))
  await symlink(outside, path.join(projectRoot, 'dist/agent-pipeline'))
  await assert.rejects(buildRelease(undefined, { projectRoot }), /real directory/)
  await rm(path.join(projectRoot, 'dist'), { recursive: true })
  await symlink(outside, path.join(projectRoot, 'dist'))
  await assert.rejects(buildRelease(undefined, { projectRoot }), /symlink/)
  assert.deepEqual(await readdir(outside), [])
})
