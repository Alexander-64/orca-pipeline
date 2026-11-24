// Offline-executor smoke of an npm tarball installed outside the checkout.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const tarball = await realpath(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'pipeline-clean-install-'))
const project = join(root, 'project'), tools = join(root, 'tools')
await mkdir(project); await mkdir(tools); await symlink(process.execPath, join(tools, 'node'))
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))), PATH: tools + ':/usr/bin:/bin:/usr/sbin:/sbin' }
assert.notEqual(spawnSync('/usr/bin/which', ['orca'], { env }).status, 0)
const npm = spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).stdout.trim()
const installed = spawnSync(npm, ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { env, encoding: 'utf8', timeout: 180000 })
assert.equal(installed.status, 0, installed.stderr || installed.stdout)
const cli = join(root, 'node_modules/.bin/pipeline')
const call = (...args) => {
  const result = spawnSync(cli, [...args, '-C', project, '--json'], { env, cwd: project, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
const installedPackage = JSON.parse(await readFile(join(root, 'node_modules/orca-agent-pipeline/package.json'), 'utf8'))
assert.equal(call('--version').version, installedPackage.version)
await mkdir(join(project, '.agent-pipeline'))
const fixture = join(project, 'executor.mjs')
await writeFile(fixture, 'let prompt="";for await(const c of process.stdin)prompt+=c;console.log(JSON.stringify({type:"result",outcome:"succeeded",text:"Independent installed executor: "+prompt}));\n')
await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { installed: { kind: 'jsonl', executable: process.execPath, args: [fixture] } } }))
await writeFile(join(project, 'plan.yaml'), `name: clean-install
objective: Prove standalone three-step execution without Orca or development files
commandPolicy: {readOnly: true}
steps:
 - {id: analyze, title: Analyze, agent: installed, spec: Inspect, acceptance: [pwd]}
 - {id: improve, title: Improve, agent: installed, spec: Prioritize, needs: [analyze], acceptance: [pwd]}
 - {id: review, title: Review, agent: installed, spec: Verify independently, needs: [improve], acceptance: [pwd]}
`)
let run, finished = false
try {
  const doctor = call('doctor')
  assert.ok(Array.isArray(doctor.piModels))
  assert.equal(call('validate', '-f', 'plan.yaml').valid, true)
  run = call('run', '-f', 'plan.yaml')
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const current = call('status', '--run', run.id).runs[0]
    if (!['done', 'failed', 'cancelled'].includes(current.status)) continue
    finished = true
    assert.equal(current.status, 'done')
    assert.equal(Object.keys(current.tasks).length, 3)
    const attempts = Object.values(current.tasks).flatMap(task => task.attempts)
    assert.equal(new Set(attempts.map(attempt => attempt.dispatchId)).size, 3)
    assert.ok(attempts.every(attempt => attempt.checks[0].exitCode === 0))
    const evidenceFile = join(root, 'e2e-evidence.json')
    const directory = join(project, '.agent-pipeline/runtime/standalone-checks')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'request.json'), JSON.stringify({ version: 1, id: 'installed-checks', runId: 'installation-smoke', taskId: 'checks', token: 'fixture', cwd: project, commands: ['pwd'], policy: { readOnly: true } }))
    const actor = join(root, 'node_modules/orca-agent-pipeline/dist/terminal/checks.mjs')
    const checked = spawnSync(process.execPath, [actor, join(directory, 'request.json')], { env, cwd: project, encoding: 'utf8', timeout: 10000 })
    assert.equal(checked.status, 0, checked.stderr)
    const standaloneChecks = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    assert.equal(standaloneChecks.outcome, 'succeeded'); assert.equal(standaloneChecks.checks[0].exitCode, 0)
    await writeFile(evidenceFile, JSON.stringify({ tarball, project, orcaOnPath: false, run: current, standaloneChecks }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ status: 'passed', tarball, project, runId: run.id, evidenceFile, orcaOnPath: false }))
    break
  }
  assert.ok(finished, 'Installed runtime did not settle')
} finally {
  if (run && !finished) { try { call('stop', '--run', run.id) } catch {} }
  call('shutdown')
}
