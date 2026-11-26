import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const limit = 512 * 1024
function git(cwd: string, args: string[], index?: string, input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.quotePath=true', ...args], {
    cwd, env: index ? { ...env, GIT_INDEX_FILE: index } : env, input, encoding: 'utf8',
    maxBuffer: limit, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe']
  })
}

export function head(project: string) {
  if (realpathSync(project) !== realpathSync(git(project, ['rev-parse', '--show-toplevel']).trim())) throw new Error('Select a Git worktree root')
  return git(project, ['rev-parse', '--verify', 'HEAD']).trim()
}

export function gitAdmin(project: string) {
  return realpathSync(git(project, ['rev-parse', '--absolute-git-dir']).trim())
}

export function createCopy(source: string, target: string) {
  const base = head(source)
  git(source, ['worktree', 'add', '--detach', target, base])
  return base
}

export function reviewChanges(source: string, copy: string, base: string, acceptDigest?: string) {
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error('Missing original commit')
  if (realpathSync(source) === realpathSync(copy)) throw new Error('Review requires a separate worktree')
  const common = (cwd: string) => realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  if (common(source) !== common(copy)) throw new Error('Worktrees belong to different repositories')
  head(copy)
  const sourceHead = head(source)
  const temp = mkdtempSync(join(tmpdir(), 'pipeline-diff-'))
  try {
    const index = join(temp, 'index')
    git(copy, ['read-tree', base], index)
    // Use a private index so previewing also includes ordinary new files. Keep runtime
    // directories out of the patch even in repositories without pipeline ignore rules.
    const args = ['--glob-pathspecs', 'add', '-A', '--', '.', ':(exclude).agent-pipeline', ':(exclude).orca', ':(exclude)node_modules']
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
    execFileSync('git', args, { cwd: copy, env: { ...env, GIT_INDEX_FILE: index }, timeout: 30_000, stdio: 'pipe' })
    const diff = ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base]
    const names = git(copy, [...diff, '--name-only', '-z'], index).split('\0').filter(Boolean)
    const patch = git(copy, [...diff, '--src-prefix=a/', '--dst-prefix=b/'], index)
    if (patch.includes('\ufffd') || /^Binary files |^GIT binary patch|^(?:index .* |(?:new file|deleted file|old|new) mode )160000$/m.test(patch)) throw new Error('Review supports UTF-8 text patches only')
    const digest = createHash('sha256').update(JSON.stringify([realpathSync(source), realpathSync(copy), base, patch])).digest('hex')
    if (acceptDigest !== undefined) {
      if (!patch || digest !== acceptDigest) throw new Error('Patch changed or empty. Preview again.')
      if (sourceHead !== base) throw new Error('Source HEAD changed since the isolated run started')
      const dirty = git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...names])
      if (dirty) throw new Error('Source files already have changes. Review them before accepting.')
      git(source, ['apply', '--index', '--check', '--whitespace=nowarn', '-'], undefined, patch)
      git(source, ['apply', '--index', '--whitespace=nowarn', '-'], undefined, patch)
    }
    return { patch, digest, source: realpathSync(source), files: names }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
