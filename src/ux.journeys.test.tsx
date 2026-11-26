import { assert, mockHost, mount, test } from 'orca/testing'
import type { HistoryQuery } from './types'
import * as panel from './panel'
import { demoDashboard, demoRun, dependencyRun } from './testData'

const selected = { 'pipeline.run-mode': 'existing', 'pipeline.run': demoRun.id, 'pipeline.stage': 'monitor' }

test('UX S08 unknown launch explains disabled agent and offers only recovery', async () => {
  const run = structuredClone(demoRun)
  run.status = 'paused'; run.tasks.build.unconfirmedStart = true
  run.tasks.build.error = 'Agent claude is disabled. Choose an enabled agent.'
  let repairs = 0
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run], recoveryWarning: 'unconfirmed receipt' }),
    'run.repair': () => { repairs++; return { dashboard: { ...demoDashboard, runs: [demoRun] }, report: { runId: run.id, status: 'continued', messages: ['Готовые результаты сохранены.'], updatedAt: run.updatedAt } } }
  } }) })
  assert.ok(view.find({ text: /Агент claude выключен/ }))
  assert.equal(view.find({ text: 'Продолжить' }), null)
  assert.ok(view.find({ text: /Запуск на паузе.*Разберись и продолжи/ }))
  await view.press({ text: 'Разберись и продолжи' })
  assert.equal(repairs, 1)
  assert.equal(view.persisted.plugin['pipeline.stage'], 'monitor')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S08 ordinary pause resumes without launching diagnosis', async () => {
  const run = { ...demoRun, status: 'paused' as const }
  let resumes = 0
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] }),
    'run.resume': () => { resumes++; return { run: demoRun } }
  } }) })
  await view.press({ text: 'Продолжить' })
  assert.equal(resumes, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S07 errors and skipped steps never masquerade as successful progress', async () => {
  const run = structuredClone(dependencyRun)
  run.tasks.independent.status = 'skipped'
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] })
  } }) })
  assert.equal(view.find({ type: 'Progress' })?.props.value, 20)
  assert.ok(view.find({ text: 'Ошибок: 1' }))
  assert.ok(view.find({ text: 'Пропущено: 1' }))
  assert.ok(view.find({ text: 'Ожидают: 2' }))
  await view.press({ text: 'Посмотреть доступные результаты' })
  assert.ok(view.find({ text: 'Промежуточные результаты' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S07 successful completion links directly to final results', async () => {
  const run = structuredClone(demoRun)
  run.status = 'done'; run.tasks.build.status = 'done'
  run.tasks.build.attempts[0].output = 'Проверенный итог'
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] })
  } }) })
  assert.equal(view.find({ type: 'Progress' })?.props.value, 100)
  await view.press({ text: 'Посмотреть результат' })
  assert.equal(view.find({ type: 'CodeView' })?.props.code, 'Проверенный итог')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S01 same scenario in different projects remains distinguishable through results', async () => {
  const old = structuredClone(demoRun)
  old.id = 'foreign'; old.workspaceId = 'foreign-workspace'; delete old.sourceWorkspaceId
  old.workspacePath = '/work/another-project'
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun], runHistory: [demoRun, old] })
  } }) })
  const options = view.find({ label: 'Прогон' })!.props.options as { value: string; label: string }[]
  assert.match(options.find(option => option.value === old.id)!.label, /another-project/)
  await view.select({ label: 'Прогон' }, old.id)
  assert.ok(view.find({ text: /Рабочая папка: \/work\/another-project/ }))
  await view.select({ label: 'Agent Pipeline' }, 'result')
  assert.equal(view.valueOf({ label: 'Прогон' }), old.id)
  await view.post('run.changed', { run: { ...demoRun, updatedAt: '2026-11-17T23:59:59Z' } })
  assert.equal(view.valueOf({ label: 'Прогон' }), old.id)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S01 new draft then history retains project context without altering the saved run', async () => {
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun] })
  } }) })
  await view.press({ text: 'Новый прогон' })
  await view.type({ label: 'Цель' }, 'Новый проектный замысел')
  await view.select({ label: 'Прогон' }, demoRun.id)
  assert.ok(view.find({ text: new RegExp('Рабочая папка: ' + demoRun.workspacePath) }))
  await view.press({ text: 'Новый прогон' })
  assert.equal(view.valueOf({ label: 'Цель' }), 'Новый проектный замысел')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S12 metrics navigation survives refresh with no runs', async () => {
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => demoDashboard } }) })
  await view.select({ label: 'Agent Pipeline' }, 'metrics')
  assert.ok(view.find({ label: 'По агентам' }))
  await view.press({ text: 'Обновить данные' })
  assert.equal(view.persisted.plugin['pipeline.tab'], 'metrics')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('UX S11 built-in tasks stay accessible with unavailable optional Beads', async () => {
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun], beadsEnabled: true, beads: [], beadsError: 'bd unavailable' })
  } }) })
  await view.select({ label: 'Agent Pipeline' }, 'beads')
  assert.ok(view.find({ label: 'Задачи pipeline' }))
  await view.toggle({ label: /Внешний трекер Beads/ })
  assert.ok(view.find({ text: /bd unavailable/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

for (const failOlder of [false, true]) test('late project ' + (failOlder ? 'error' : 'reply') + ' preserves the current task list', async () => {
  const a = demoDashboard.workspaces[0]
  const b = { ...a, id: 'workspace-B', name: 'Project B' }
  const snapshot = (ws: typeof a) => {
    const run = structuredClone(demoRun)
    run.id = 'run-' + ws.id; run.workspaceId = ws.id
    run.scenario.steps[0].title = 'Unique row for ' + ws.id
    return { ...demoDashboard, workspaces: [a, b], projects: [], runs: [run], runHistory: [run] }
  }
  let first = true
  const pending = new Map<string, () => void>()
  const host = mockHost({ requests: { 'dashboard.get': ({workspaceId}) => {
    if (first) { first = false; return snapshot(a) }
    const ws = workspaceId === b.id ? b : a
    return new Promise((resolve, reject) => {
      const finish = () => failOlder && ws.id === b.id ? reject(new Error('stale project failure')) : resolve(snapshot(ws))
      pending.set(ws.id, finish)
    })
  } } })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.run-mode': 'new' } } })
  const original = view.select({label:'Project'}, b.id)
  await new Promise(resolve => setTimeout(resolve,15)); assert.ok(pending.has(b.id))
  const latest = view.select({label:'Project'}, a.id)
  await new Promise(resolve => setTimeout(resolve,15)); assert.ok(pending.has(a.id))
  pending.get(a.id)!(); await new Promise(resolve => setTimeout(resolve,20))
  pending.get(b.id)!(); await Promise.all([original, latest]); await new Promise(resolve => setTimeout(resolve,20))
  assert.equal(view.valueOf({label:'Project'}), a.id)
  assert.equal(view.find({ text: /stale project failure/ }), null)
  await view.select({label:'Agent Pipeline'}, 'beads')
  assert.deepEqual(view.rowsOf({label:'Pipeline tasks'}), ['run-'+a.id+'::build'])
  await view.unmount()
})


for (const language of ['en', 'ru'] as const) test('archive opens older results from a different project in ' + language, async () => {
  const ru = language === 'ru'
  const old = structuredClone(demoRun)
  old.id = 'old-000'; old.workspaceId = 'other'; old.scenario.name = 'Archive fixture'
  const project = { ...demoDashboard.workspaces[0], id: 'other', name: 'Other project' }
  const opened: unknown[] = [], queries: HistoryQuery[] = []
  const summary = { id: old.id, name: old.scenario.name, workspaceId: project.id, createdAt: old.createdAt, status: old.status, controller: 'terminal' as const }
  const host = mockHost({ settings: { interfaceLanguage: language }, requests: {
    'dashboard.get': input => ({ ...demoDashboard, workspaces: [...demoDashboard.workspaces, project], runs: [demoRun], runHistory: input.selectedRunId === old.id ? [demoRun, old] : [demoRun] }),
    'history.list': input => {
      queries.push(input)
      return input.before ? { rows: [summary], more: false } : { rows: [{ ...summary, id: 'recent-001', name: 'Latest fixture' }], more: true }
    },
    'history.open': input => { opened.push(input); return { run: old } }
  } })
  const view = await mount(panel, { host, persisted: { plugin: selected } })
  await view.press({ text: ru ? 'Вся история прогонов' : 'Browse all runs' })
  await view.press({ text: ru ? 'Загрузить ещё' : 'Load older runs' })
  assert.deepEqual(queries[1].before, { id:'recent-001', createdAt: old.createdAt })
  await view.press({ text: /Archive fixture · Other project/ })
  assert.deepEqual(opened, [{ workspaceId: project.id, id: old.id }])
  assert.equal(view.valueOf({ label: ru ? 'Прогон' : 'Run' }), old.id)
  assert.ok(view.find({ text: /Archive fixture/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

for (const code of [7, null]) test('failed result opens the recorded attempt with exit ' + code, async () => {
  const run = structuredClone(demoRun), attempt = run.tasks.build.attempts[0]
  run.status = 'paused'; run.tasks.build.status = 'failed'
  attempt.checks = [{ command: 'verify-document', exitCode: code }]
  const opened: unknown[] = []
  const view = await mount(panel, { persisted: { plugin: { ...selected, 'pipeline.tab':'result' } }, host: mockHost({ requests:{
    'dashboard.get': () => ({ ...demoDashboard, runs:[run] }),
    'run.open': value => { opened.push(value); return { opened: true } }
  } }) })
  assert.ok(view.find({ text: code === null ? /did not report an exit code: verify-document/ : /exit 7.*verify-document/ }))
  await view.toggle({ label: 'Attempt 1 · codex' })
  assert.ok(JSON.stringify(view.tree()).includes(attempt.output!))
  await view.press({ text:'Open agent session' })
  assert.deepEqual(opened, [{ id:run.id, dispatchId:attempt.dispatchId }])
  await view.unmount()
})


for (const status of ['running','done'] as const) test('healthy ' + status + ' results keep recovery guidance out of the way', async () => {
  const run = { ...demoRun, status }
  const view = await mount(panel, { host: mockHost({requests: { 'dashboard.get': () => ({ ...demoDashboard, runs:[run] }) }}),
    persisted: { plugin: { ...selected, 'pipeline.tab':'result' } } })
  assert.equal(view.find({ text:/Recovery checks agent sessions/ }), null)
  assert.ok(view.find({ text: status === 'done' ? 'Run completed' : 'Partial results' }))
  await view.unmount()
})

test('a completed conditional run has no remaining work after a skip and a superseded attempt', async () => {
  const run = structuredClone(dependencyRun)
  run.status = 'done'
  for (const task of Object.values(run.tasks)) task.status = 'done'
  run.tasks.independent.status = 'skipped'
  run.tasks.research.status = 'superseded'
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] })
  } }) })
  assert.ok(view.find({ text: 'Skipped: 1' }))
  await view.press({ text: 'View result' })
  assert.ok(view.find({ text: 'Finished: 4' }))
  assert.ok(view.find({ text: 'Remaining: 0' }))
  assert.ok(view.find({ text: 'Skipped: 1' }))
  await view.unmount()
})

for (const backend of ['orca', 'local'] as const) test('live monitor shows recorded acceptance activity and routes the ' + backend + ' attempt', async () => {
  const run = structuredClone(demoRun)
  run.controller = 'terminal'
  run.backend = backend
  Object.assign(run.tasks.build, { activity: 'acceptance', activityObservedAt: run.createdAt, waitReason: 'pwd' })
  const opened: unknown[] = []
  const view = await mount(panel, { persisted: { plugin: selected }, host: mockHost({ requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] }),
    'run.open': input => { opened.push(input); return { opened: true } }
  } }) })
  assert.ok(view.find({ text: 'Last observation · acceptance · ' + run.createdAt }))
  assert.equal(view.find({ text: /Agent is waiting for a reply: pwd/ }), null)
  if (backend === 'orca') {
    await view.press({ text: 'Open codex session' })
    assert.deepEqual(opened, [{ id: run.id, dispatchId: run.tasks.build.attempts[0].dispatchId }])
  } else assert.equal(view.find({ text: 'Open codex session' }), null)
  await view.unmount()
})
