import { assert, mockHost, mount, test } from 'orca/testing'
import { BeadsClient } from './beads'
import * as panel from './panel'
import { demoDashboard } from './testData'
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
  const host = mockHost({
    requests: { 'dashboard.get': () => ({ ...demoDashboard, beads }) }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  await view.type({ label: 'Search tasks' }, 'export')
  assert.deepEqual(view.rowsOf({ label: 'Beads tasks' }), ['bd-open'])
  await view.select({ label: 'Status' }, 'closed')
  assert.deepEqual(view.rowsOf({ label: 'Beads tasks' }), [])
  await view.unmount()
})

test('activating an open row claims it and refreshes the board', async () => {
  let action = ''
  const host = mockHost({
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, beads }),
      'beads.action': ({ action: requested }) => {
        action = requested
        return { ...demoDashboard, beads: beads.map((bead) => bead.id === 'bd-open' ? { ...bead, status: 'in_progress' } : bead) }
      }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  await view.activateRow({ label: 'Beads tasks' }, 'bd-open')
  assert.equal(action, 'claim')
  assert.ok(view.find({ text: /in_progress/ }))
  await view.unmount()
})

test('shows epic completion progress', async () => {
  const host = mockHost({
    requests: { 'dashboard.get': () => ({ ...demoDashboard, beads }) }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'pipeline.tab': 'beads' } } })
  assert.ok(view.find({ text: /1\/2 closed/ }))
  await view.unmount()
})
