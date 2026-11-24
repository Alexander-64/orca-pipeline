import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { demoDashboard, demoRun, dependencyRun } from './testData'
import { parseScenario } from './scenario'
import { DEFAULT_SCENARIO, type PipelineRun } from './types'

test('loads workspaces and validates the YAML draft', async () => {
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => demoDashboard,
      'scenario.validate': ({ source }) => ({ scenario: parseScenario(source) })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Проект' }), 'workspace-1')
  await view.press({ text: 'Далее: шаги и агенты' })
  await view.press({ text: 'Проверить YAML' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('starts a run and shows its execution state', async () => {
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => demoDashboard,
      'run.start': () => ({ run: demoRun })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Далее: шаги и агенты' })
  await view.press({ text: 'Далее: запуск' })
  await view.press({ text: 'Запустить' })
  assert.ok(view.find({ text: /demo-pipeline/ }))
  assert.ok(view.find({ text: /Реализация/ }))
  await view.select({ label: 'Agent Pipeline' }, 'beads')
  await view.toggle({ label: /Внешний трекер Beads/ })
  assert.deepEqual(view.rowsOf({ label: 'Задачи Beads' }), ['bd-demo1'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('fills the draft when the planner returns a scenario', async () => {
  const source = DEFAULT_SCENARIO.replace('demo-pipeline', 'generated-pipeline')
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => demoDashboard,
      'plan.start': () => ({ plan: { id: 'plan-1', runId: 'run-plan', dispatchId: 'dispatch-plan', agent: 'codex', status: 'running' } })
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Цель' }, 'Сделать экспорт')
  await view.press({ text: 'Составить YAML' })
  assert.ok(view.find({ text: 'Planner работает…' }))
  await view.post('plan.changed', {
    plan: { id: 'plan-1', runId: 'run-plan', dispatchId: 'dispatch-plan', agent: 'codex', status: 'done', source }
  })
  assert.equal(view.persisted.plugin['pipeline.stage'], 'steps')
  await view.select({ label: 'Вид редактора' }, 'yaml')
  assert.match(String(view.valueOf({ label: 'YAML-сценарий' })), /generated-pipeline/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('retry button sends the failed run and renders the recovered state', async () => {
  const failed: PipelineRun = {
    ...demoRun,
    status: 'failed',
    tasks: {
      build: {
        ...demoRun.tasks.build,
        status: 'failed',
        attempts: [{ ...demoRun.tasks.build.attempts[0], status: 'failed', reason: 'quota' }]
      }
    }
  }
  const recovered: PipelineRun = { ...demoRun, status: 'done' }
  const host = mockHost({ settings: { interfaceLanguage: 'ru' },
    requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [failed] }),
      'run.retry': () => ({ run: recovered })
    }
  })
  const view = await mount(panel, {
    host,
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': failed.id } }
  })
  await view.press({ text: 'Следующий fallback' })
  assert.ok(view.find({ role: 'status', text: 'Завершён' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('validates the real default draft', () => {
  assert.equal(parseScenario(DEFAULT_SCENARIO).steps.length, 2)
})

test('Pi question answers keep a stable message ID across an uncertain response and do not resolve approval gates', async () => {
  const run = structuredClone(demoRun)
  run.controller = 'terminal'; run.backend = 'local'
  run.tasks.build.interaction = 'pi'; run.tasks.build.activity = 'waiting-user'
  run.tasks.build.questions = [{ id: 'question-1', question: 'What should I prioritize?', state: 'waiting', askedAt: '2026-11-13T00:00:00Z' }]
  const sent: { id: string; stepId: string; messageId: string; text: string; questionId?: string }[] = []
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [run] }),
      'run.message': input => {
        sent.push(input)
        if (sent.length === 1) throw new Error('Receipt timeout; delivery unknown')
        const changed = structuredClone(run)
        changed.tasks.build.questions![0].state = 'answered'
        changed.tasks.build.messages = [{ id: input.messageId, state: 'queued', at: '2026-11-13T00:00:01Z' }]
        return { run: changed, receipt: changed.tasks.build.messages[0] }
      }
    } }),
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': run.id, 'pipeline.step': 'build' } }
  })
  await view.type({ label: 'Ответ агенту' }, 'UX; preserve $VALUE')
  await view.press({ text: 'Ответить' })
  assert.ok(view.find({ text: /delivery unknown/ }))
  await view.press({ text: 'Ответить' })
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], sent[1])
  assert.equal(sent[0].questionId, 'question-1')
  assert.equal(sent[0].text, 'UX; preserve $VALUE')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('execution selects an active step automatically and links to its exact window', async () => {
  const opened: unknown[] = []
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun] }),
      'run.open': input => { opened.push(input); return { opened: true } }
    } }),
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': demoRun.id } }
  })
  await view.press({ text: 'Открыть окно агента' })
  assert.deepEqual(opened, [{ id: demoRun.id, dispatchId: demoRun.tasks.build.attempts.at(-1)!.dispatchId }])
  await view.press({ text: 'Открыть workspace Pipeline' })
  assert.deepEqual(opened[1], { id: demoRun.id })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('execution follows the active step and displays progress as a percentage', async () => {
  const first = structuredClone(demoRun)
  const second = { ...first.scenario.steps[0], id: 'review', title: 'Review now', agent: 'kimi', fallback: [], needs: ['build'] }
  first.scenario.steps.push(second)
  first.tasks.review = { stepId: 'review', taskId: 'task_review', status: 'pending', agent: 'kimi', attempts: [] }
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [first] }) } }), persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.step': '' } } })
  const next = structuredClone(first)
  next.tasks.build.status = 'done'
  next.tasks.review.status = 'running'
  await view.post('run.changed', { run: next })
  assert.equal(view.find({ type: 'Progress' })?.props.value, 50)
  assert.ok(view.find({ text: 'Цепочка: kimi' }))
  await view.press({ text: /Реализация.*codex/ })
  assert.ok(view.find({ text: 'Цепочка: codex → claude' }))
  await view.press({ text: 'Следить за активным шагом' })
  assert.ok(view.find({ text: 'Цепочка: kimi' }))
  await view.unmount()
})

test('a native question remains answerable in a failed run and selects the waiting step', async () => {
  const run = structuredClone(demoRun)
  run.status = 'failed'; run.tasks.build.status = 'blocked'; run.tasks.build.interaction = 'native'
  run.tasks.build.questions = [{ id: 'native-q', question: 'Where are predecessor results?', state: 'waiting', askedAt: '' }]
  const sent: unknown[] = []
  const answered = structuredClone(run); answered.tasks.build.questions![0].state = 'answered'
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => ({ ...demoDashboard, runs: [run] }),
    'run.message': input => { sent.push(input); return { run: answered, receipt: { id: input.messageId, state: 'delivered', at: '' } } }
  } }), persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': run.id } } })
  assert.ok(view.find({ text: 'Откройте вопрос и ответьте в панели. Завершённые шаги повторять не нужно.' }))
  await view.press({ text: `Ответить: ${run.scenario.steps.find(step => step.id === 'build')!.title}` })
  assert.ok(view.find({ text: 'Where are predecessor results?' }))
  await view.type({ label: 'Ответ агенту' }, 'Read /pipeline/context')
  await view.press({ text: 'Ответить' })
  assert.equal(sent.length, 1)
  assert.equal((sent[0] as { questionId: string }).questionId, 'native-q')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('requires resolving source-only paths before starting in a separate workspace', async () => {
  const source = 'name: location\nobjective: Read sources\nsteps:\n - {id: a, title: Audit, spec: "Работай только в /tmp/demo. Не меняй файлы.", agent: codex, acceptance: [pwd]}'
  const starts: { separateWorkspace?: boolean }[] = []
  const view = await mount(panel, { host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
    'dashboard.get': () => demoDashboard,
    'run.start': input => { starts.push(input); return { run: demoRun } }
  } }), persisted: { plugin: { 'pipeline.stage': 'monitor', 'pipeline.draft': source, 'pipeline.separate-workspace': true } } })
  assert.ok(view.find({ text: /Отдельный workspace создаст другую папку/ }))
  await view.press({ text: 'Работать в указанной папке' })
  await view.press({ text: 'Запустить' })
  assert.equal(starts.length, 1)
  assert.equal(starts[0].separateWorkspace, false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})


test('monitor groups shuffled dependencies, shows join inputs and navigates to predecessors', async () => {
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [dependencyRun] }) } }),
    persisted: { plugin: { 'pipeline.tab': 'runs', 'pipeline.run': dependencyRun.id, 'pipeline.step': 'join' } }
  })
  assert.ok(view.find({ text: 'Независимых: 3' }))
  assert.ok(view.find({ text: '#2 → #1 · Готово' }))
  assert.ok(view.find({ text: '#3 → #1 · Ошибка' }))
  assert.ok(view.find({ text: '↓ После завершения всех:' }))
  await view.press({ text: '#3 → #1 · Ошибка' })
  assert.equal(view.persisted.plugin['pipeline.step'], 'contract')
  assert.ok(view.find({ text: 'Следует за выбранным' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('top run picker locks stored parameters and new-run mode keeps a separate editable draft', async () => {
  const saved = structuredClone(demoRun)
  saved.scenario.objective = 'Сохранённая цель'
  saved.scenario.steps[0].spec = 'Сохранённое задание'
  const other = structuredClone(saved)
  other.id = 'other-run'; other.runId = 'run_other'; other.scenario.name = 'Другой прогон'
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [saved, other] }) } }),
    persisted: { plugin: { 'pipeline.run-mode': 'existing', 'pipeline.run': saved.id, 'pipeline.stage': 'steps' } }
  })
  assert.equal(view.valueOf({ label: 'Прогон' }), saved.id)
  assert.equal(view.find({ label: 'Запуск' }), null)
  assert.ok(view.find({ label: 'Параметры этого прогона зафиксированы' }))
  assert.equal(view.find({ label: 'Название шага' }), null)
  assert.equal(view.find({ label: 'YAML-сценарий' }), null)
  assert.equal(view.find({ text: 'Открыть редактор во вкладке' }), null)
  await view.select({ label: 'Этап pipeline' }, 'project')
  assert.match(JSON.stringify(view.tree()), /Сохранённая цель/)
  assert.equal(view.find({ label: 'Цель' }), null)
  await view.select({ label: 'Этап pipeline' }, 'monitor')
  assert.equal(view.find({ text: 'Запустить' }), null)
  await view.press({ text: 'Новый прогон' })
  assert.equal(view.valueOf({ label: 'Прогон' }), 'new')
  assert.ok(view.find({ label: 'Цель' }))
  await view.type({ label: 'Цель' }, 'Новая независимая цель')
  await view.select({ label: 'Прогон' }, other.id)
  assert.equal(view.persisted.plugin['pipeline.run'], other.id)
  await view.select({ label: 'Этап pipeline' }, 'project')
  assert.match(JSON.stringify(view.tree()), /Сохранённая цель/)
  assert.equal(view.find({ label: 'Цель' }), null)
  assert.equal(saved.scenario.objective, 'Сохранённая цель')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('run result follows the top picker, distinguishes partial results and opens an exact step', async () => {
  const done = structuredClone(demoRun)
  done.status = 'done'; done.tasks.build.status = 'done'
  done.tasks.build.attempts[0].output = 'Готовый результат первой работы'
  done.tasks.build.attempts[0].checks = [{ command: 'npm test', exitCode: 0 }]
  done.tasks.build.attempts[0].artifactPath = '/tmp/result-one.json'
  const partial = structuredClone(demoRun)
  partial.id = 'partial-run'; partial.runId = 'run_partial'
  partial.tasks.build.attempts[0].output = 'Промежуточный вывод второй работы'
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [done, partial] }) } }),
    persisted: { plugin: { 'pipeline.tab': 'result', 'pipeline.run-mode': 'existing', 'pipeline.run': done.id } }
  })
  assert.ok(view.find({ text: 'Прогон завершён' }))
  assert.ok(view.find({ type: 'CodeView' })?.props.code === 'Готовый результат первой работы')
  await view.toggle({ label: 'Реализация · Готово' })
  assert.ok(view.find({ text: /Код завершения: 0/ }))
  assert.ok(view.find({ text: 'Артефакт: /tmp/result-one.json' }))
  await view.select({ label: 'Прогон' }, partial.id)
  assert.ok(view.find({ text: 'Промежуточные результаты' }))
  assert.ok(view.find({ type: 'CodeView' })?.props.code === 'Промежуточный вывод второй работы')
  await view.toggle({ label: 'Реализация · Выполняется' })
  await view.press({ text: 'Открыть шаг' })
  assert.equal(view.persisted.plugin['pipeline.run'], partial.id)
  assert.equal(view.persisted.plugin['pipeline.step'], 'build')
  assert.equal(view.persisted.plugin['pipeline.stage'], 'monitor')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a new run can launch beside an existing run and immediately switches to its locked snapshot', async () => {
  const launched = structuredClone(demoRun)
  launched.id = 'newly-launched'; launched.runId = 'run_newly_launched'
  let starts = 0
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [demoRun] }),
      'run.start': () => { starts++; return { run: launched } }
    } }),
    persisted: { plugin: { 'pipeline.run-mode': 'new', 'pipeline.stage': 'monitor' } }
  })
  await view.press({ text: 'Запустить' })
  assert.equal(starts, 1)
  assert.equal(view.valueOf({ label: 'Прогон' }), launched.id)
  assert.equal(view.persisted.plugin['pipeline.run-mode'], 'existing')
  assert.equal(view.find({ text: 'Запустить' }), null)
  await view.select({ label: 'Этап pipeline' }, 'steps')
  assert.equal(view.find({ label: 'Название шага' }), null)
  assert.ok(view.find({ label: 'Параметры этого прогона зафиксированы' }))
  await view.select({ label: 'Agent Pipeline' }, 'result')
  assert.ok(view.find({ text: 'Промежуточные результаты' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})


test('global history picker opens older runs outside the currently selected project and follows updates', async () => {
  const old = structuredClone(demoRun)
  old.id = 'old-run'; old.workspaceId = 'other-project'; old.scenario.name = 'Старый прогон'
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: { 'dashboard.get': () => ({ ...demoDashboard, runs: [], runHistory: [old], recoveryWarning: 'unconfirmed receipt' }) } }),
    persisted: { plugin: { 'pipeline.run-mode': 'new' } }
  })
  const picker = view.find({ label: 'Прогон' })!
  assert.ok((picker.props.options as { value: string }[]).some(option => option.value === old.id))
  await view.select({ label: 'Прогон' }, old.id)
  assert.equal(view.find({ label: 'Запусков пока нет' }), null)
  assert.ok(view.find({ text: 'Старый прогон' }))
  await view.select({ label: 'Agent Pipeline' }, 'result')
  old.status = 'done'; old.tasks.build.status = 'done'
  old.tasks.build.attempts[0].output = 'Восстановленный итог'
  await view.post('run.changed', { run: old })
  assert.ok(view.find({ text: 'Прогон завершён' }))
  assert.equal(view.find({ type: 'CodeView' })?.props.code, 'Восстановленный итог')
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('repair button diagnoses the selected run, shows progress and uses the repaired dashboard', async () => {
  const paused = structuredClone(demoRun); paused.status = 'paused'
  const continued = structuredClone(demoRun)
  const calls: unknown[] = []
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [paused], recoveryWarning: 'unconfirmed receipt' }),
      'run.repair': input => { calls.push(input); return {
        dashboard: { ...demoDashboard, runs: [continued] },
        report: { runId: continued.id, status: 'continued', messages: ['Исполнитель восстановлен, прогон продолжен.'], updatedAt: '2026-11-17T10:00:00Z' }
      } }
    } }), persisted: { plugin: { 'pipeline.run-mode': 'existing', 'pipeline.run': paused.id, 'pipeline.stage': 'steps' } }
  })
  await view.press({ text: 'Разберись и продолжи' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(calls, [{ id: paused.id }])
  assert.equal(view.persisted.plugin['pipeline.stage'], 'steps')
  assert.ok(view.find({ text: 'Исполнитель восстановлен, прогон продолжен.' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('repair action keeps one stable position and preserves navigation during progress and completion', async () => {
  const paused = structuredClone(demoRun); paused.status = 'paused'
  const continued = structuredClone(demoRun)
  const view = await mount(panel, {
    host: mockHost({ settings: { interfaceLanguage: 'ru' }, requests: {
      'dashboard.get': () => ({ ...demoDashboard, runs: [paused], recoveryWarning: 'unconfirmed receipt' }),
      'run.repair': () => ({ dashboard: { ...demoDashboard, runs: [continued] }, report: { runId: paused.id, status: 'continued', messages: ['Прогон продолжен'], updatedAt: '2026-11-17T10:00:01Z' } })
    } }), persisted: { plugin: { 'pipeline.run-mode': 'existing', 'pipeline.stage': 'steps', 'pipeline.tab': 'scenario' } }
  })
  const before = view.find({ type: 'Button', text: 'Разберись и продолжи' })!
  assert.equal(view.findAll({ type: 'Button', text: 'Разберись и продолжи' }).length, 1)
  await view.post('recovery.changed', { report: { runId: paused.id, status: 'checking', messages: ['Сверяю исполнителя'], updatedAt: '2026-11-17T10:00:00Z' } })
  assert.equal(view.find({ type: 'Button', text: 'Разбираюсь…' })?.path, before.path)
  assert.equal(view.find({ type: 'Button', text: 'Разбираюсь…' })?.disabled, true)
  await view.select({ label: 'Agent Pipeline' }, 'result')
  await view.post('recovery.changed', { report: { runId: paused.id, status: 'blocked', messages: ['Проверка завершена'], updatedAt: '2026-11-17T10:00:01Z' } })
  await view.press({ text: 'Разберись и продолжи' })
  assert.equal(view.find({ type: 'Button', text: 'Разберись и продолжи' })?.path, before.path)
  assert.equal(view.persisted.plugin['pipeline.stage'], 'steps')
  assert.equal(view.persisted.plugin['pipeline.tab'], 'result')
  const other = { ...structuredClone(continued), id: 'background-run' }
  await view.post('run.changed', { run: other })
  assert.equal(view.valueOf({ label: 'Прогон' }), paused.id)
  assert.ok(view.find({ text: 'Прогон продолжен' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('opens a repository scenario, previews its review and approval, and saves the edited draft', async () => {
  const source = DEFAULT_SCENARIO.replace('agent: codex', 'agent: codex\n    reviewAgent: claude\n    approval: Approve this change?')
  const calls: string[] = []
  const view = await mount(panel, { host: mockHost({ requests: {
    'dashboard.get': () => demoDashboard,
    'scenario.files': () => ({ names: ['example.yaml'] }),
    'scenario.open': ({ name }) => { assert.equal(name, 'example.yaml'); return { source } },
    'scenario.save': ({ name, previous, source: updated, workspaceId }) => {
      assert.equal(previous, source)
      assert.equal(workspaceId, 'workspace-1')
      assert.equal(updated, source.replace('demo-pipeline', 'edited'))
      calls.push(name)
      return { saved: true }
    }
  } }) })
  await view.toggle({ label: 'Repository scenarios' })
  await view.press({ text: 'Browse pipelines/' })
  await view.select({ label: 'Repository file' }, 'example.yaml')
  await view.press({ text: 'Open file' })
  await view.press({ text: 'Next: steps and agents' })
  await view.press({ text: 'Next: launch' })
  await view.toggle({ label: 'Run preview' })
  const tree = JSON.stringify(view.tree())
  for (const value of ['Approve this change?', 'implement-evidence', '/tmp/demo', 'pnpm test']) assert.ok(tree.includes(value), value)
  await view.press({ text: 'Back: steps and agents' })
  await view.type({ label: 'Scenario YAML' }, source.replace('demo-pipeline', 'edited'), { replace: true })
  await view.press({ text: 'Back: project and task' })
  await view.press({ text: 'Save file' })
  assert.deepEqual(calls, ['example.yaml'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a folder restored from 0.1.3 previews and starts in its actual directory', async () => {
  const folder = { ...demoDashboard.workspaces[0], kind: 'folder' as const, branch: null }
  const requests: boolean[] = []
  const view = await mount(panel, {
    host: mockHost({ requests: {
      'dashboard.get': () => ({ ...demoDashboard, workspaces: [folder] }),
      'run.start': input => { requests.push(input.separateWorkspace === true); return { run: demoRun } }
    } }),
    persisted: { plugin: { 'pipeline.workspace': folder.id, 'pipeline.draft': DEFAULT_SCENARIO, 'pipeline.stage': 'monitor' } }
  })
  try {
    await view.toggle({ label: 'Run preview' })
    assert.ok(JSON.stringify(view.tree()).includes(folder.path))
    assert.ok(!JSON.stringify(view.tree()).includes('New copy of ' + folder.path))
    await view.press({ text: 'Start run' })
    assert.deepEqual(requests, [false])
  } finally { await view.unmount() }
})
