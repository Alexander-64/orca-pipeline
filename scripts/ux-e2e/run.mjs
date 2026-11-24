import { rm, mkdtemp, cp, readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { cases, press } from './journeys.mjs'
import { buildRelease, root } from '../build-release.mjs'
const cli = process.env.ORCA_CLI_COMMAND || '/Applications/Orca.app/Contents/Resources/bin/orca'
const key = 'alexander-64.agent-pipeline-ux-e2e'
const evidence = resolve(root, '.orca/ux-evidence/native')
await mkdir(evidence, { recursive: true })
let folder
if (process.argv.includes('--existing')) folder = await readFile(join(evidence, 'fixture-path.txt'), 'utf8')
else {
const base = await mkdtemp(join(await realpath(tmpdir()), 'pipeline-native-ux-'))
folder = join(base, 'plugin')
await buildRelease(folder)
await mkdir(join(folder, 'scripts/ux-e2e'), { recursive: true })
await cp(join(root, 'scripts/ux-e2e/worker.ts'), join(folder, 'scripts/ux-e2e/worker.ts'))
await cp(join(root, 'src/testData.ts'), join(folder, 'src/testData.ts'))
const manifest = JSON.parse(await readFile(join(folder, 'orca-plugin.json'), 'utf8'))
Object.assign(manifest, { id: 'agent-pipeline-ux-e2e', name: 'Agent Pipeline — UX E2E', capabilities: [], main: 'scripts/ux-e2e/worker.ts' })
manifest.contributes = { panels: manifest.contributes.panels }
await writeFile(join(folder, 'orca-plugin.json'), JSON.stringify(manifest))
let source = await readFile(join(folder, 'src/panel.tsx'), 'utf8')
const resetCode = `set(language, 'ru'); set(runMode, boot.mode); set(runId, boot.dashboard.runs[0]?.id ?? ''); set(stage, boot.stage); set(tab, 'scenario'); set(stepId, ''); set(plan, null); set(appliedPlans, []); set(error, null); set(recoveryReport, null); set(workspaceId, boot.dashboard.workspaces[0].id); set(data, boot.dashboard); set(objective, ''); set(viewMode, 'split'); set(separateWorkspace, false); set(launchExpanded, true); syncDraft(boot.source)`
source = source.replace('export function setup(ctx: PanelContext): void {', `export function setup(ctx: PanelContext): void {
ctx.subscriptions.push((plugin.on as any)('e2e.reset', (boot: any) => { ${resetCode} }))`)
source = source.replace('<Heading>Agent Pipeline</Heading>', `<Heading>Agent Pipeline</Heading>
<Button onPress={async () => { await (plugin.request as any)('e2e.observe', JSON.parse(JSON.stringify({ tab: read(tab), stage: read(stage), mode: read(runMode), runId: read(runId), stepId: read(stepId), draft: read(draft), objective: read(objective), workspace: read(workspaceId), error: read(error), draftError: read(draftError), editError: read(editError), report: read(recoveryReport), data: read(data), inspector: read(inspector) }))) }}>E2E capture</Button>`)
await writeFile(join(folder, 'src/panel.tsx'), source)
}
if (process.argv.includes('--headless')) {
  // Run the same cases against the actual panel and a test-host-mounted worker.
  if (process.argv.includes('--existing')) throw new Error('Headless cases require a fresh fixture')
  try {
    for (const [source, target] of [['journeys.mjs', 'journeys.mjs'], ['headless-case.ts', 'journeys.test.tsx']]) {
      await cp(join(root, 'scripts/ux-e2e', source), join(folder, 'scripts/ux-e2e', target))
    }
    const result = spawnSync(cli, ['plugin', 'test', folder, '--json'], { encoding: 'utf8', maxBuffer: 16e6 })
    await writeFile(join(evidence, 'headless.log'), result.stderr + '\n' + result.stdout)
    console.log(result.stderr.split('\n').filter(line => /pass |fail |✖/.test(line)).join('\n'))
    process.exitCode = result.status ?? 1
  } finally { await rm(folder, { recursive: true, force: true }) }
  process.exit(process.exitCode)
}
function call(args, permit = false) {
  const result = spawnSync(cli, [...args, '--json'], { encoding: 'utf8', maxBuffer: 16e6, cwd: root })
  let value; try { value = JSON.parse(result.stdout) } catch { throw new Error(result.stdout + result.stderr) }
  if (permit && value.error?.code === 'approval_required') {
    assert.equal(value.error.data.pluginKey, key)
    assert.deepEqual(value.error.data.grants.capabilities, [])
    return call([...args, '--approve', value.error.data.approvalFingerprint])
  }
  if (!value.ok) throw new Error(JSON.stringify(value.error))
  return value.result
}
const request = (name, data = {}) => call(['plugin', 'dev', 'request', key, name, '--data', JSON.stringify(data)]).result
const captures = []
if (process.argv.includes('--audit-cua')) {
  const results = []
  for (const item of cases) {
    const report = JSON.parse(await readFile(join(evidence, item.id + '.cua.json'), 'utf8'))
    assert.equal(report.status, 'PASS'); item.check(report.observation, report)
    results.push({ id: item.id, status: 'PASS', driver: 'CUA + native renderer + IPC fixture' })
  }
  await writeFile(join(evidence, 'cua-summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2))
  console.log(results.length + '/24 native journeys verified'); process.exit(0)
}
if (process.argv.includes('--configure')) {
  const id = process.argv[process.argv.indexOf('--configure') + 1]
  const item = cases.find(item => item.id === id); assert.ok(item, 'unknown case')
  request('e2e.configure', item.config); console.log(JSON.stringify(item.actions)); process.exit(0)
}
if (process.argv.includes('--check-case')) {
  const id = process.argv[process.argv.indexOf('--check-case') + 1]
  const item = cases.find(item => item.id === id); assert.ok(item, 'unknown case')
  const report = request('e2e.report'); assert.ok(report.observation, 'missing capture')
  item.check(report.observation, report)
  await writeFile(join(evidence, id + '.cua.json'), JSON.stringify({ id, driver: 'cua', status: 'PASS', ...report }, null, 2))
  console.log(id + ' PASS (CUA)'); process.exit(0)
}
if (process.argv.includes('--prepare')) {
  call(['plugin', 'dev', 'load', folder], true)
  call(['plugin', 'open', key, '--panel', 'agent-pipeline'])
  await writeFile(join(evidence, 'fixture-path.txt'), folder)
  console.log('PREPARED ' + folder); process.exit(0)
}
try {
  if (!process.argv.includes('--existing')) call(['plugin', 'dev', 'load', folder], true)
  for (const item of cases) {
    call(['plugin', 'dev', 'reload', folder])
    call(['plugin', 'shot', key, '--width', '1100', '--out', join(evidence, 'ready.png')])
    request('e2e.configure', item.config)
    try {
      const shot = call(['plugin', 'shot', key, '--act', JSON.stringify([...item.actions, press('E2E capture')]), '--width', '1100', '--out', join(evidence, item.id + '.png')])
      assert.deepEqual(shot.errors, []); assert.equal(shot.pendingRequests, 0)
      const report = request('e2e.report')
      assert.ok(report.observation, 'missing end-of-journey state')
      item.check(report.observation, report)
      await writeFile(join(evidence, item.id + '.json'), JSON.stringify({ shot, ...report }, null, 2))
      captures.push({ id: item.id, status: 'PASS' }); console.log(item.id + ' PASS')
    } catch (error) { captures.push({ id: item.id, status: 'FAIL', error: String(error) }); console.log(item.id + ' FAIL ' + error); if (/hidden or minimized|runtime_timeout/.test(String(error))) throw error }
  }
} finally {
  await writeFile(join(evidence, 'summary.json'), JSON.stringify({ folder, results: captures }, null, 2))
  call(['plugin', 'dev', 'unload', folder])
  call(['plugin', 'open', 'alexander-64.agent-pipeline', '--panel', 'agent-pipeline'])
}
if (captures.length !== cases.length || captures.some(c => c.status !== 'PASS')) process.exitCode = 1
