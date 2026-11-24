// Copied next to the fixture panel by run.mjs --headless for Orca's test host.
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as panel from '../../src/panel'
import * as fixture from './worker'
import { cases } from './journeys.mjs'

for (const item of cases) test(item.id, async () => {
  const worker = await mountWorker(fixture)
  const requests = Object.fromEntries(['dashboard.get', 'scenario.validate', 'plan.start', 'run.start', 'run.repair', 'run.tick', 'run.message', 'e2e.observe']
    .map(name => [name, (input: any) => worker.request(name, input)]))
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests }) })
  let cursor = 0
  const deliver = async () => {
    while (cursor < worker.posts.length) {
      const event = worker.posts[cursor++]
      await view.post(event.event, event.payload as any)
    }
  }
  try {
    await worker.request('e2e.configure', item.config)
    await deliver()
    for (const action of item.actions) {
      if (action.press) await view.press(action.press)
      if (action.toggle) await view.toggle(action.toggle)
      if (action.select) await view.select(action.select, action.value)
      if (action.type) await view.type(action.type, action.text, { replace: true })
      if (action.press?.text === 'Составить YAML') {
        const deadline = Date.now() + 3000
        while (!worker.posts.slice(cursor).some(event => event.event === 'plan.changed') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      await deliver()
    }
    await view.press({ text: 'E2E capture' })
    const report = await worker.request('e2e.report') as any
    item.check(report.observation, report)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount(); await worker.deactivate() }
})
