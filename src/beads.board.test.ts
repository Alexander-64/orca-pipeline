import { assert, mockHost, mount, test } from 'orca/testing'
import { BeadsClient } from './beads'
import * as panel from './panel'
import { demoDashboard, demoRun } from './testData'
import type { Bead } from './types'

test('claim, close and reopen use native bd commands', async () => {
  const calls: string[][] = []
  const client = new BeadsClient('/work', async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: '{}', stderr: '' }
  })
  await client.claim('bd-1')
  await client.close('bd-1', 'done')
  await client.reopen('bd-1')
  assert.deepEqual(calls, [
    ['update', 'bd-1', '--claim', '--json'],
    ['close', 'bd-1', '--reason', 'done', '--json'],
    ['reopen', 'bd-1', '--json']
  ])
})

const beads: Bead[] = [
  { id: 'bd-open', title: 'Implement export', status: 'open', issueType: 'task', parentId: 'bd-epic' },
  { id: 'bd-closed', title: 'Fix parser', status: 'closed', issueType: 'task', parentId: 'bd-epic' },
  { id: 'bd-epic', title: 'Reporting epic', status: 'open', issueType: 'epic' }
]

test('filters board rows by search and status', async () => {
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: { 'dashboard.get': () => ({ ...demoDashboard, beads }) }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  await view.toggle({ label: /Внешний трекер Beads/ })
  await view.type({ label: 'Поиск по задачам' }, 'export')
  assert.deepEqual(view.rowsOf({ label: 'Задачи Beads' }), ['bd-open'])
  await view.select({ label: 'Статус' }, 'closed')
  assert.deepEqual(view.rowsOf({ label: 'Задачи Beads' }), [])
  await view.unmount()
})

test('activating an open row claims it and refreshes the board', async () => {
  let action = ''
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, beads }),
      'beads.action': ({ action: requested }) => {
        action = requested
        return { ...demoDashboard, beads: beads.map((bead) => bead.id === 'bd-open' ? { ...bead, status: 'in_progress' } : bead) }
      }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  await view.toggle({ label: /Внешний трекер Beads/ })
  await view.activateRow({ label: 'Задачи Beads' }, 'bd-open')
  assert.equal(action, 'claim')
  assert.ok(view.find({ text: /in_progress/ }))
  await view.unmount()
})

test('shows epic completion progress', async () => {
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: { 'dashboard.get': () => ({ ...demoDashboard, beads }) }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  await view.toggle({ label: /Внешний трекер Beads/ })
  assert.ok(view.find({ text: /1\/2 закрыто/ }))
  await view.unmount()
})


test('pipeline task board works without Beads and opens the exact run step', async () => {
  const run = structuredClone(demoRun)
  run.tasks.build.status = 'failed'
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run], beads: [], beadsEnabled: false })
  } }), persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  assert.deepEqual(view.rowsOf({ label: 'Задачи pipeline' }), [`${run.id}::build`])
  await view.select({ label: 'Статус задачи pipeline' }, 'done')
  assert.deepEqual(view.rowsOf({ label: 'Задачи pipeline' }), [])
  await view.select({ label: 'Статус задачи pipeline' }, 'failed')
  await view.type({ label: 'Поиск задач pipeline' }, 'Реализация')
  assert.deepEqual(view.rowsOf({ label: 'Задачи pipeline' }), [`${run.id}::build`])
  await view.activateRow({ label: 'Задачи pipeline' }, `${run.id}::build`)
  assert.equal(view.persisted.plugin['pipeline.run'], run.id)
  assert.equal(view.persisted.plugin['pipeline.step'], 'build')
  assert.equal(view.persisted.plugin['pipeline.stage'], 'monitor')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('optional Beads failure has a friendly connection state without unusable filters', async () => {
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, beads: [], beadsEnabled: true, beadsError: 'spawn bd ENOENT' })
  } }), persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  assert.ok(view.find({ label: 'Задачи появятся после запуска' }))
  await view.toggle({ label: /Внешний трекер Beads/ })
  assert.ok(view.find({ text: 'Beads пока не подключён' }))
  assert.equal(view.find({ label: 'Задачи Beads' }), null)
  assert.equal(view.find({ label: 'Поиск по задачам' }), null)
  assert.equal(view.find({ text: 'spawn bd ENOENT' }), null)
  await view.toggle({ label: 'Технические подробности' })
  assert.ok(view.find({ text: 'spawn bd ENOENT' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})
