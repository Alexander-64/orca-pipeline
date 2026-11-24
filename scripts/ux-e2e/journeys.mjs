import assert from 'node:assert/strict'

export const press = text => ({ press: { text } })
const select = (label, value) => ({ select: { label }, value })
const type = (label, text) => ({ type: { label }, text, replace: true })
const toggle = label => ({ toggle: { label } })
export const cases = []
function add(id, config, actions, check) { cases.push({ id, config, actions, check }) }
const newDraft = { empty: true, stage: 'project' }
const editor = { empty: true, stage: 'steps' }
add('S01-1', {}, [select('Прогон', 'old-e2e'), select('Этап pipeline', 'project')], s => { assert.equal(s.runId, 'old-e2e'); assert.equal(s.mode, 'existing') })
add('S01-2', {}, [select('Прогон', 'old-e2e'), select('Agent Pipeline', 'result'), press('Обновить данные')], s => assert.equal(s.runId, 'old-e2e'))
add('S02-1', newDraft, [select('Проект', 'workspace-2'), type('Цель', 'E2E objective'), press('Далее: шаги и агенты')], s => { assert.equal(s.workspace, 'workspace-2'); assert.equal(s.stage, 'steps'); assert.equal(s.objective, 'E2E objective') })
add('S02-2', {}, [press('Новый прогон'), type('Цель', 'Keep this draft'), select('Прогон', 'old-e2e'), press('Новый прогон')], s => { assert.equal(s.mode, 'new'); assert.equal(s.objective, 'Keep this draft') })
add('S03-1', newDraft, [type('Цель', 'Plan E2E'), press('Составить YAML')], s => { assert.match(s.draft, /planned-e2e/); assert.equal(s.stage, 'steps') })
add('S03-2', { ...newDraft, invalidPlan: true }, [type('Цель', 'Bad plan'), press('Составить YAML')], s => { assert.doesNotMatch(s.draft, /steps: \[/); assert.ok(s.error || s.draftError) })
add('S04-1', editor, [press('Добавить параллельный'), press('Добавить дочерний'), press('Проверить YAML')], (s, r) => { assert.equal(s.draftError, null); assert.ok(r.calls.some(c => c.name === 'scenario.validate')); assert.ok(s.draft.split('id:').length >= 5) })
add('S04-2', editor, [type('YAML-сценарий', 'name: cycle\nobjective: test\nsteps:\n - id: a\n   title: Cycle\n   agent: codex\n   spec: test\n   needs: [a]\n   acceptance: [pwd]\n'), press('Проверить YAML')], s => assert.match(s.draftError || s.error, /цикл|cycle|завис/i))
add('S05-1', editor, [select('Модель · Основной агент', 'e2e-model'), select('Усилие · Основной агент', 'high'), press('Применить шаг')], s => { assert.match(s.draft, /e2e-model/); assert.match(s.draft, /high/) })
add('S05-2', editor, [select('Модель · Основной агент', 'e2e-model'), select('Усилие · Основной агент', 'high'), select('Agent implement', 'claude'), press('Применить шаг')], s => assert.doesNotMatch(s.draft, /e2e-model/))
add('S06-1', { empty: true, stage: 'monitor' }, [press('Запустить')], (s, r) => { assert.equal(s.mode, 'existing'); assert.equal(s.runId, 'started-e2e'); assert.equal(r.calls.filter(c => c.name === 'run.start').length, 1) })
add('S06-2', { empty: true, stage: 'monitor', source: 'name: confined\nobjective: test\nsteps:\n - id: audit\n   title: Audit\n   agent: codex\n   spec: "Работай только в /tmp/demo"\n   acceptance: [pwd]\n' }, [toggle('Отдельный workspace Pipeline в меню Orca'), press('Работать в указанной папке'), press('Запустить')], (s, r) => assert.equal(r.calls.find(c => c.name === 'run.start').input.separateWorkspace, false))
add('S07-1', {}, [press('Обновить')], s => assert.equal(s.data.runs[0].tasks.build.status, 'done'))
add('S07-2', { tickFail: true }, [press('Обновить')], s => assert.equal(s.data.runs[0].tasks.build.status, 'failed'))
add('S08-1', { unknown: true }, [toggle('Подробности диагностики')], s => { assert.ok(s.data.recoveryWarning); assert.ok(s.data.runs[0].tasks.build.unconfirmedStart) })
add('S08-2', { unknown: true, repairDelay: 1000 }, [press('Разберись и продолжи')], (s, r) => { assert.equal(s.stage, 'monitor'); assert.equal(s.report.status, 'continued'); assert.equal(r.calls.filter(c => c.name === 'run.repair').length, 1) })
add('S09-1', { question: true }, [type('Ответ агенту', 'Check dependencies'), press('Ответить')], (s, r) => assert.equal(r.calls.find(c => c.name === 'run.message').input.questionId, 'question-e2e'))
add('S09-2', { question: true, messageTimeout: true }, [type('Ответ агенту', 'Retry stable message'), press('Ответить'), press('Ответить')], (s, r) => { const calls = r.calls.filter(c => c.name === 'run.message'); assert.equal(calls.length, 2); assert.equal(calls[0].input.messageId, calls[1].input.messageId); assert.equal(r.calls.filter(c => c.name === 'run.resolve-gate').length, 0) })
add('S10-1', { done: true }, [press('Посмотреть результат')], s => { assert.equal(s.tab, 'result'); assert.equal(s.data.runs[0].tasks.build.attempts[0].output, 'E2E final result') })
add('S10-2', {}, [press('Посмотреть доступные результаты'), toggle('Реализация · Выполняется'), press('Открыть шаг')], s => { assert.equal(s.tab, 'scenario'); assert.equal(s.stepId, 'build') })
add('S11-1', {}, [select('Agent Pipeline', 'beads')], s => { assert.equal(s.tab, 'beads'); assert.equal(s.data.beadsEnabled, false) })
add('S11-2', { beads: true }, [select('Agent Pipeline', 'beads'), toggle('Внешний трекер Beads · требует настройки')], s => { assert.match(s.data.beadsError, /unavailable/); assert.equal(s.data.runs.length, 1) })
add('S12-1', {}, [select('Agent Pipeline', 'metrics')], s => { assert.equal(s.tab, 'metrics'); assert.equal(s.data.metrics.totalSteps, 1) })
add('S12-2', {}, [press('Обновить'), select('Agent Pipeline', 'metrics'), press('Обновить данные')], s => assert.equal(s.data.metrics.completedSteps, 1))
