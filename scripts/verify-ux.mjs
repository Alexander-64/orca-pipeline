// Run after every UX increment; retain evidence outside watched source content.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const cli = process.env.ORCA_CLI_COMMAND || (process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources/bin/orca' : 'orca-ide')
const tag = process.argv[2] || 'latest'
if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error('Use an alphanumeric evidence tag')
const directory = join(root, '.orca', 'ux-evidence', tag)
mkdirSync(directory, { recursive: true })
for (const [name, file, args] of [
  ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '-p', '.']],
  ['journeys-and-regression', cli, ['plugin', 'test', '.', '--json']],
  ['render', cli, ['plugin', 'check', '.', '--json']]
]) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  writeFileSync(join(directory, name + '.log'), result.stdout + '\n' + result.stderr)
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${directory})`)
  if (result.status !== 0) process.exit(result.status || 1)
}
