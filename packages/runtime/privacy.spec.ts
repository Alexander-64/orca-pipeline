import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, redactValue } from '../core/failover'
import { RunStore } from './store'
import { runCommandExecutor } from './executor'

test('nested credential fields and JSON report strings are redacted without corrupting event JSON', () => {
  const value = { apiKey: 'synthetic-key-value', nested: [{ password: 123 }, { text: JSON.stringify({ accessToken: 'inner-synthetic-token', count: 4 }) }], text: 'Authorization: Bearer synthetic-bearer-value' }
  const result = redactValue(value)
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /synthetic-key-value|inner-synthetic-token|synthetic-bearer-value/)
  assert.equal(JSON.parse(JSON.parse(serialized).nested[1].text).count, 4)
  const store = new RunStore(':memory:')
  try {
    store.event('privacy', value)
    assert.deepEqual(store.events()[0].data, result)
  } finally { store.close() }
  assert.equal(JSON.parse(redactSecrets('{"password":"quoted secret value"}')).password, '[REDACTED]')
})

test('stderr credentials split across process chunks are redacted as one diagnostic', async () => {
  const events: { kind: string; text?: string }[] = []
  const code = `process.stderr.write('Authorization: Bear'); setTimeout(() => { process.stderr.write('er synthetic-split-token'); console.log(JSON.stringify({type:'result', outcome:'succeeded', text:'Safe report'})) }, 30)`
  const result = await runCommandExecutor({ kind: 'jsonl', executable: process.execPath, args: ['-e', code] }, process.cwd(), 'Test', true, new AbortController().signal, event => events.push(event))
  assert.equal(result.text, 'Safe report')
  assert.equal(events.filter(event => event.kind === 'executor.stderr').length, 1)
  assert.doesNotMatch(JSON.stringify(events), /synthetic-split-token/)
  assert.match(events.find(event => event.kind === 'executor.stderr')!.text!, /REDACTED/)
})
