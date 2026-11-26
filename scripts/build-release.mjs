import * as fs from 'node:fs/promises'
const { lstat, mkdir, mkdtemp, readFile, readdir, rm } = fs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Explicit production inventory: new runtime modules must be reviewed here.
const modules = 'agents artifacts beads capacity cli commands coordinator editor failover metrics step-status diagnostics i18n model-catalog mutations planner pr projects protocol quota scenario scenarioFiles templates terminal-bridge types usage worker'.split(' ')
const coreModules = 'agent-preferences types scenario editor commands capacity quota failover metrics artifacts mutations chunked-storage coordinator contracts terminal-ipc results review'.split(' ')
const required = ['orca-plugin.json', 'pipelines/release.yaml', 'examples/failover/README.md', 'LICENSE', 'README.md', 'README.en.md', 'README.ru.md', 'README.zh-CN.md', 'docs/architecture.md', 'docs/release-0.2.1.md', 'docs/release-0.2.1.ru.md', 'docs/release-0.3.0.md', 'docs/release-0.3.0.ru.md', 'docs/terminal-agent-implementation-plan.md', 'docs/ux/README.md', 'docs/ux/cases.md', 'docs/ux/validation.md', ...modules.map(name => `src/${name}.ts`), ...coreModules.map(name => `packages/core/${name}.ts`), 'packages/runtime/store.ts', 'packages/runtime/process-lifetime.ts', 'src/panel.tsx', 'src/history-view.tsx', 'src/result-view.tsx', 'src/graph-editor.ts']

const pngSignature = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex')

async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function regular(file) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`)
}
async function sourceDirectory(root, dir) {
  const stat = await lstat(path.join(root, dir))
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid source directory: ${dir}`)
}
function screenshotPaths(manifest) {
  if (manifest.screenshots === undefined) return new Set()
  if (!Array.isArray(manifest.screenshots)) throw new Error('Invalid manifest screenshots')
  const files = new Set()
  for (const screenshot of manifest.screenshots) {
    const file = screenshot?.path
    if (typeof file !== 'string' || !/^assets\/[a-z0-9][a-z0-9_-]*\.png$/.test(file) || files.has(file)) {
      throw new Error(`Invalid manifest screenshot path: ${file}`)
    }
    files.add(file)
  }
  return files
}
async function vendorFiles(dir, prefix = 'vendor/yaml') {
  const result = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${relative}`)
    if (entry.isDirectory() && (entry.name === 'dist' || prefix.startsWith('vendor/yaml/dist'))) {
      result.push(...await vendorFiles(path.join(dir, entry.name), relative))
    } else if (entry.isFile() && (entry.name === 'LICENSE' || /\.(?:js|ts)$/.test(entry.name))) result.push(relative)
    else throw new Error(`Unexpected vendor artifact: ${relative}`)
  }
  return result
}
export async function buildRelease(out = 'dist/agent-pipeline', { projectRoot = root, io = fs } = {}) {
  const root = path.resolve(projectRoot)
  const destination = path.resolve(root, out)
  const relative = path.relative(root, destination).split(path.sep)
  if (relative.some(part => ['.agent-pipeline', '.orca', '.git', 'node_modules'].includes(part)) || ['src', 'vendor', 'scripts', 'packages', 'docs', 'assets', 'pipelines', 'examples'].includes(relative[0])) throw new Error('Output overlaps protected project data')
  const replace = destination === path.join(root, 'dist', 'agent-pipeline')
  const previous = await exists(destination)
  if (previous && !replace) throw new Error(`Output already exists; choose a fresh --out path: ${destination}`)
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('Default output must be a real directory')
  for (let parent = path.dirname(destination); ; parent = path.dirname(parent)) {
    const stat = await exists(parent)
    if (stat?.isSymbolicLink()) throw new Error(`Output parent is a symlink: ${parent}`)
    if (parent === path.dirname(parent)) break
  }
  for (const dir of ['docs', 'docs/ux', 'packages', 'packages/core', 'packages/runtime', 'src', 'pipelines', 'examples', 'examples/failover', 'vendor', 'vendor/yaml', 'vendor/yaml/dist']) await sourceDirectory(root, dir)
  const manifestFile = path.join(root, 'orca-plugin.json')
  await regular(manifestFile)
  const manifestBytes = await readFile(manifestFile)
  const manifest = JSON.parse(manifestBytes)
  const screenshots = screenshotPaths(manifest)
  if (screenshots.size) await sourceDirectory(root, 'assets')
  const files = [...required, ...screenshots, ...await vendorFiles(path.join(root, 'vendor/yaml'))]
  const contents = new Map()
  for (const file of files.sort()) {
    await regular(path.join(root, file))
    const bytes = file === 'orca-plugin.json' ? manifestBytes : await readFile(path.join(root, file))
    if (screenshots.has(file)) {
      if (bytes.length < 33 || !bytes.subarray(0, pngSignature.length).equals(pngSignature) || !bytes.subarray(-pngEnd.length).equals(pngEnd)) {
        throw new Error(`Invalid PNG screenshot: ${file}`)
      }
      if (bytes.readUInt32BE(16) < 1280 || bytes.readUInt32BE(20) < 800) throw new Error(`Screenshot must be at least 1280×800: ${file}`)
      contents.set(file, bytes)
      continue
    }
    if (bytes.includes(0)) throw new Error(`Binary rejected: ${file}`)
    const text = bytes.toString('utf8')
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[A-Z0-9]{16}\b/.test(text)) throw new Error(`Possible credential in ${file}`)
    // Verify static relative imports resolve to packaged files; Orca supplies host imports.
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))
      if (![target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}/index.js`].some(candidate => files.includes(candidate))) throw new Error(`Unpackaged import in ${file}: ${match[1]}`)
    }
    contents.set(file, bytes)
  }
  const entries = [...manifest.contributes.panels, ...(manifest.contributes.customEditors ?? [])]
  if (manifest.manifestVersion !== 2 || !contents.has(manifest.main) || !entries.every(panel => contents.has(panel.entry))) throw new Error('Invalid manifest entry points')
  await mkdir(path.dirname(destination), { recursive: true })
  // Own a unique sibling workspace; only this workspace and the explicit default
  // output may be removed. Keep the old output until staging is complete.
  const staging = await mkdtemp(path.join(path.dirname(destination), '.release-stage-'))
  const fresh = path.join(staging, 'fresh')
  const backup = path.join(staging, 'previous')
  let backedUp = false
  let preserveBackup = false
  try {
    await mkdir(fresh)
    for (const [file, bytes] of contents) {
      const target = path.join(fresh, file)
      await mkdir(path.dirname(target), { recursive: true })
      await io.writeFile(target, bytes, { flag: 'wx' })
    }
    // Reserve custom output exclusively, including against a concurrent creator.
    if (!replace) await mkdir(destination)
    else {
      const current = await exists(destination)
      if (current) {
        if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Default output must be a real directory')
        await io.rename(destination, backup)
        backedUp = true
      }
    }
    try {
      await io.rename(fresh, destination)
    } catch (error) {
      if (backedUp) {
        try { await io.rename(backup, destination) }
        catch (rollbackError) {
          preserveBackup = true
          throw new AggregateError([error, rollbackError], `Replacement and rollback failed; previous release retained at ${backup}`)
        }
      } else if (!replace) await fs.rmdir(destination)
      throw error
    }
  } finally {
    // Never destroy the last good release if rollback itself failed.
    if (!preserveBackup) await rm(staging, { recursive: true, force: true })
  }
  return { output: destination, files: [...contents.keys()], licenseIncluded: contents.has('LICENSE') }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('Usage: node scripts/build-release.mjs [--out <new-directory>]')
    console.log(JSON.stringify(await buildRelease(args[1]), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
