import { assert, test } from 'orca/testing'
import { agentOptions, discoverAgents } from './agents'

test('merges workspace and account agents without leaking account ids', async () => {
  const agents = await discoverAgents(async () => ({ agents: [{ agent: ' codex ', title: 'Workspace Codex', state: 'working' }, { agent: 'custom', title: 'Custom' }, { agent: null }] }), async () => ({ codex: { accounts: [{ id: 'secret-account' }] }, extra: { accounts: [] }, usage: {} }))
  assert.equal(agents.filter(a => a.id === 'codex').length, 1)
  assert.equal(agents.find(a => a.id === 'codex')?.status, 'working')
  assert.equal(agents.find(a => a.id === 'codex')?.label, 'codex')
  assert.ok(agents.some(a => a.id === 'extra'))
  assert.equal(agents.some(a => a.id === 'secret-account' || a.id === 'usage'), false)
  assert.ok(agentOptions(agents, ['my-custom']).some(a => a.value === 'my-custom'))
})

test('discovery tolerates either source failing and both failing', async () => {
  const failed = async () => { throw new Error('offline') }
  assert.ok((await discoverAgents(failed, async () => ({ extra: { accounts: [] } }))).some(a => a.id === 'extra'))
  assert.ok((await discoverAgents(async () => ({ agents: [{ agent: 'custom' }] }), failed)).some(a => a.id === 'custom'))
  assert.ok((await discoverAgents(failed, failed)).some(a => a.id === 'codex'))
})
