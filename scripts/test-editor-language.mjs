// Browser integration test for the isolated editor. Inject only the host APIs it uses.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const browser = process.env.CHROME_BIN || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium')
const directory = await mkdtemp(join(tmpdir(), 'pipeline-language-'))
try {
  const bundle = await build({ entryPoints: ['src/graph-editor.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })
  const source = 'name: locale-test\nobjective: Test editor\nsteps:\n - {id: a, title: Исходный шаг, spec: Test, agent: codex, acceptance: [pwd]}\n - {id: b, title: Review, spec: Review, agent: codex, acceptance: [pwd]}\n'
  const html = `<!doctype html><meta charset="utf-8"><body><script type="module">
  let language = 'en', listener, changes = 0
  const original = ${JSON.stringify(source)}
  window.orca = {
    settings: { get: async () => language, onDidChange: cb => { listener = cb } },
    document: { session: async () => ({ value: original, onReplace() {}, change() { changes++ } }) }
  }
  function check(value, reason) { if (!value) throw Error(reason) }
  try {
    await (async () => { ${bundle.outputFiles[0].text} })()
    check(document.documentElement.lang === 'en' && document.querySelector('header').textContent.includes('Add successor'), 'first render')
    const title = () => document.querySelector('aside input')
    title().value = 'Черновик — $&'
    for (const [next, expected] of [['ru', 'Добавить следующий'], ['en', 'Add successor']]) {
      language = next
      await listener({key:'interfaceLanguage'})
      check(document.documentElement.lang === next && document.querySelector('header').textContent.includes(expected), 'header switch')
      check(document.querySelector('.canvas').getAttribute('aria-label') === (next === 'en' ? 'Pipeline graph' : 'Граф pipeline'), 'accessible name')
      check(title().value === 'Черновик — $&', 'unapplied inspector input')
      check(document.querySelector('.yaml').value === original && changes === 0, 'document was rewritten')
    }
    const port = key => document.querySelector('[data-focus="' + key + '"]')
    const press = key => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    const start = id => { port('output:' + id).focus(); port('output:' + id).click() }
    for (const locale of ['en', 'ru']) {
      language = locale; await listener({key:'interfaceLanguage'})
      start('a'); port('input:b').focus(); press('Escape')
      check(document.activeElement === port('output:a'), 'cancel focus')
      start('a'); port('input:b').click()
      check(port('edge:a:b') && document.activeElement === port('input:b'), 'connect and restore focus')
      const count = changes
      start('b'); port('input:a').click()
      check(changes === count && !port('edge:b:a') && document.querySelector('#status.error'), 'cycle rejection')
      port('edge:a:b').focus()
      port('edge:a:b').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))
      check(document.activeElement.dataset.selectedEdge === 'a', 'inspect edge focus')
      document.activeElement.click(); await Promise.resolve()
      check(!port('edge:a:b') && document.activeElement === port('input:b'), 'disconnect focus')
      check(document.querySelector('#status').getAttribute('aria-live') === 'polite', 'live announcement')
    }
    document.body.dataset.result = 'pass'
  } catch (error) { document.body.dataset.result = String(error) }
  </script>`
  const file = join(directory, 'editor.html')
  await writeFile(file, html)
  const result = spawnSync(browser, ['--headless', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(file).href],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4e6 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr.slice(-1000))
  const outcome = result.stdout.match(/<body[^>]*data-result="([^"]+)"/)?.[1]
  assert.equal(outcome, 'pass', outcome || 'editor did not finish')
  console.log('PASS · editor EN → RU → EN, draft, document, keyboard connections, cycle rejection and focus')
} finally { await rm(directory, { recursive: true, force: true }) }
