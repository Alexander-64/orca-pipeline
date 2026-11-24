import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { stripVTControlCharacters } from 'node:util'
import type { PipelineRun, Scenario, Project } from '../core/types'
import { waves, connectSteps, disconnectSteps, deleteStep, patchStep, validateGraph } from '../core/editor'
import { commandArgs } from '../runtime/acceptance'
import { appendCondition, conditionValue, parseCondition, parseOutputSchema, conditionLabel } from '../core/results'
import type { Predicate } from '../core/types'

export type ViewModel = {
  project: string; stage: 1 | 2 | 3; goal: string; scenario?: Scenario; source?: string; file?: string
  selected?: string; run?: PipelineRun; busy?: string; message?: string; full?: boolean; yaml?: boolean; offset: number; follow: boolean
  activity: Record<string, string>
  help?: boolean; backend?: 'local' | 'orca'
  assistantReply?: string
  projects?: Project[]
}

export function setStage(model: ViewModel, stage: 1 | 2 | 3): void {
  if (stage > 1 && !model.scenario) throw new Error('Сначала составьте или откройте сценарий')
  model.stage = stage; model.offset = 0
  model.help = false
}

// Chat is free text, not a shell command: preserve quotes, $, semicolons and line breaks.
export function interactionCommand(line: string, questionId?: string): { text: string; questionId?: string } | undefined {
  const match = /^:(send|answer)\s+([\s\S]+)$/.exec(line)
  if (!match) return undefined
  if (!match[2].trim()) throw new Error('Введите сообщение после команды')
  if (match[1] === 'answer' && !questionId) throw new Error('У выбранного агента нет ожидающего вопроса')
  return { text: match[2], ...(match[1] === 'answer' ? { questionId } : {}) }
}

export function editScenario(scenario: Scenario, command: string, executors: string[]): Scenario {
  const jsonCommand = /^(when|schema)\s+(\S+)\s+([\s\S]+)$/.exec(command)
  if (jsonCommand) {
    const [, verb, id, input] = jsonCommand
    const value = input === 'off' ? undefined : JSON.parse(input)
    return patchStep(scenario, id, verb === 'when' ? { when: value === undefined ? undefined : parseCondition(value) } : { outputSchema: value === undefined ? undefined : parseOutputSchema(value) })
  }
  const [verb, a, b, ...rest] = commandArgs(command)
  switch (verb) {
    case 'link': if (!a || !b) throw new Error('link исходный-шаг зависимый-шаг'); return connectSteps(scenario, a, b)
    case 'unlink': if (!a || !b) throw new Error('unlink исходный-шаг зависимый-шаг'); return disconnectSteps(scenario, a, b)
    case 'delete': return deleteStep(scenario, a)
    case 'agent':
      if (!executors.includes(b)) throw new Error('Неизвестный исполнитель: ' + b)
      return patchStep(scenario, a, { agent: b, fallback: scenario.steps.find(step => step.id === a)!.fallback.filter(item => item !== b) })
    case 'title': return patchStep(scenario, a, { title: [b, ...rest].join(' ') })
    case 'spec': return patchStep(scenario, a, { spec: [b, ...rest].join(' ') })
    case 'approval': return patchStep(scenario, a, { approval: [b, ...rest].join(' ') || undefined })
    case 'join':
      if (!['all_success', 'all_settled'].includes(b)) throw new Error('join ID all_success или all_settled')
      return patchStep(scenario, a, { join: b as 'all_success' | 'all_settled' })
    case 'condition': {
      const [field, op, ...value] = rest
      const schema = scenario.steps.find(step => step.id === b)?.outputSchema?.[field]
      const target = scenario.steps.find(step => step.id === a)
      if (!target || !schema) throw new Error('condition STEP SOURCE FIELD OP VALUE; SOURCE должен объявлять поле результата')
      const clause = parseCondition({ step: b, field, op, value: conditionValue(schema.type, op as Predicate['op'], value.join(' ')) })
      return patchStep(scenario, a, { when: appendCondition(target.when, clause) })
    }
    case 'add': {
      if (!a || scenario.steps.some(step => step.id === a)) throw new Error('add требует новый уникальный id')
      const template = scenario.steps[0]
      return validateGraph({ ...scenario, steps: [...scenario.steps, { ...template, id: a, title: a, spec: 'Опишите результат и границы работы', needs: b ? [b] : [], fallback: [], approval: undefined, reviewAgent: undefined, role: undefined, gateFor: undefined, when: undefined, join: undefined, outputSchema: undefined, maxAttempts: 1, maxRepairs: 0 }] })
    }
    default: throw new Error('Команды редактора: link, unlink, agent, title, spec, approval, add, delete')
  }
}

const clean = (text: string) => stripVTControlCharacters(stripTerminalSequences(text)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const fit = (text: string, width: number) => clean(truncateToWidth(clean(text), Math.max(1, width)))

export function renderView(model: ViewModel, width: number, height: number): string[] {
  width = Math.max(12, width); height = Math.max(8, height)
  const scenario = model.stage === 3 && model.run ? model.run.scenario : model.scenario
  const heading = ['1. Проект и задача', '2. Шаги и агенты', '3. Запуск и наблюдение'].map((text, index) => index + 1 === model.stage ? '[' + text + ']' : text).join('  →  ')
  const header = [fit('Agent Pipeline · ' + model.project, width), fit(heading, width), fit(model.busy ? '◌ ' + model.busy : model.message ?? 'F1/F2/F3 — этапы · :help — команды · :detach — выйти', width), '─'.repeat(width)]
  let left: string[] = [], right: string[] = []
  if (model.help) {
    right = [
      'Команды Agent Pipeline', '', 'F1 / F2 / F3 — перейти к этапу; переход не запускает работу.',
      'На этапе 1 введите задачу и нажмите Enter — planner составит YAML.',
      'На этапах 2 и 3 обычный текст — помощнику: изменить план, узнать статус, запустить или поставить на паузу.', '',
      ':project /путь — выбрать проект', ':open /путь/план.pipeline.yaml — открыть YAML',
      ':backend local — самостоятельные процессы', ':backend orca — видимые агенты Orca (приложение должно работать)',
      ':link A B — B ждёт успешного A', ':unlink A B — убрать зависимость',
      ':agent ID исполнитель — назначить исполнителя', ':title ID текст — изменить название', ':spec ID текст — изменить задание',
      ':approval ID текст — ручное подтверждение перед шагом', ':add ID [после-ID] — добавить шаг', ':delete ID — удалить шаг',
      ':schema ID {"decision":{"type":"string"}} — поля результата', ':condition STEP SOURCE FIELD eq VALUE — добавить условие AND',
      ':when ID JSON / :when ID off — задать all/any или убрать условия', ':join ID all_settled — дождаться завершения всех веток, включая пропущенные',
      ':edit — открыть $EDITOR', ':yaml — показать YAML', ':full — развернуть подробности',
      ':run — начать новый запуск из проверенного плана', ':attach [run-id] — подключиться к существующему',
      ':pause — не запускать новые шаги', ':resume — продолжить', ':stop — остановить и дождаться подтверждения',
      ':retry — повторить failed шаг по разрешённой цепочке', ':approve ID / :reject ID — решение пользователя',
      ':recover [ID] — продолжить Pi-контекст после подтверждённого завершения процесса',
      ':send текст — сообщение выбранному Pi-агенту', ':answer текст — ответ на первый ожидающий вопрос выбранного агента',
      ':window [ID] — открыть нативное окно Orca', ':follow — следовать активному шагу',
      ':detach / Ctrl+D — выйти; работа продолжается', 'Ctrl+C — отменить planner или очистить ввод',
      'Стрелки — выбрать шаг; PgUp/PgDn — прокрутить; Esc — закрыть справку.'
    ]
  } else if (model.stage === 1) {
    right = ['Проект: ' + model.project, '', 'Задача: ' + (model.goal || 'Введите задачу ниже и нажмите Enter.'), '', 'Planner исследует проект и сам составит YAML.', 'План можно проверить и изменить перед запуском.', '', ':projects — список проектов · :project номер/имя/путь', ...(model.projects?.flatMap((project, index) => [`${index + 1}. ${project.name}`, `   ${project.path}`]) ?? []), ':open /путь/сценарий.pipeline.yaml — открыть сценарий']
  } else if (scenario) {
    left = waves(scenario.steps).flatMap((wave, index) => [
      `Волна ${index + 1}${wave.length > 1 ? ' · параллельно' : ''}`,
      ...wave.flatMap(step => {
        const task = model.stage === 3 ? model.run?.tasks[step.id] : undefined
        return [`${step.id === model.selected ? '›' : ' '} ${step.title}`, `  ${step.id} · ${task?.agent ?? step.agent}`, `  ${task?.status ?? (step.needs.length ? 'после ' + step.needs.join(', ') : 'независимый старт')}`]
      })
    ])
    const step = scenario.steps.find(step => step.id === model.selected) ?? scenario.steps[0]
    const task = model.run?.tasks[step.id]
    if (model.yaml) right = (model.source ?? '').split('\n')
    else if (model.stage === 2) right = [step.title, 'ID: ' + step.id, 'Исполнитель: ' + step.agent + (step.model ? ' / ' + step.model : ''), 'После: ' + (step.needs.join(', ') || 'независимый старт'), 'Join: ' + (step.join ?? 'all_success'), ...(step.when ? ['Если: ' + conditionLabel(step.when)] : []), ...(step.outputSchema ? ['Поля результата: ' + JSON.stringify(step.outputSchema)] : []), 'Fallback: ' + (step.fallback.join(' → ') || 'не задан'), 'Подтверждение: ' + (step.approval || 'не требуется'), '', 'Задание:', step.spec, '', 'Проверки:', ...step.acceptance, '', 'Файл: ' + model.file, '', ':link A B · :unlink A B · :agent ID исполнитель', ':approval ID текст · :add ID [после-ID] · :delete ID', ':edit — редактор · :yaml — YAML · :run — запустить']
    else right = [
      (model.run ? `${model.run.status} · завершено ${Object.values(model.run.tasks).filter(task => ['done', 'failed', 'skipped', 'superseded'].includes(task.status)).length}/${scenario.steps.length} · пропущено ${Object.values(model.run.tasks).filter(task => task.status === 'skipped').length}` : 'Готово к запуску'),
      'Исполнение: ' + ((model.run?.backend ?? model.backend) === 'orca' ? 'окна Orca' : 'самостоятельные процессы'),
      ...(model.run ? ['Run: ' + model.run.id] : []), '', step.title,
      'Статус: ' + (task?.status ?? 'не запущен'),
      'Активность: ' + (model.activity[step.id] ?? task?.activity ?? 'нет подтверждённых событий'),
      ...(task?.waitReason ? ['Ожидание: ' + task.waitReason] : []),
      ...(task?.questions?.filter(question => question.state === 'waiting').flatMap(question => ['Вопрос ' + question.id + ': ' + question.question, ':answer текст — ответить']) ?? []),
      ...(task?.messages?.length ? ['Сообщения:', ...task.messages.slice(-8).map(message => `${message.id}: ${message.state}${message.error ? ' · ' + message.error : ''}`)] : []),
      ...(task?.error ? ['Ошибка: ' + task.error] : []),
      ...(task?.skipReason ? ['Пропущен: ' + task.skipReason] : []),
      ...(task?.data ? ['Проверенные данные: ' + JSON.stringify(task.data)] : []),
      ...(task?.gateId && task.status === 'blocked' ? ['Нужно решение пользователя: :approve ' + step.id + ' или :reject ' + step.id] : []),
      '', 'Попытки:', ...(task?.attempts.map((attempt, i) => `${i + 1}. ${attempt.agent} · ${attempt.status}${attempt.reason ? ' · ' + attempt.reason : ''}`) ?? []),
      ...(task?.history?.flatMap(revision => [`История входов ${revision.revision}: ${revision.status}`, ...revision.attempts.flatMap(attempt => [`${attempt.agent} · ${attempt.status} · ${attempt.artifactPath ?? attempt.dispatchId}`, attempt.output ?? ''])]) ?? []),
      '', 'Результат:', task?.attempts.at(-1)?.output ?? 'Отчёт появится после завершения исполнителя.',
      '', ':pause · :resume · :stop · :retry · :follow', ':full — развернуть · PgUp/PgDn — прокрутить'
    ]
  }
  if (model.assistantReply && !model.help) right = ['Ответ помощника:', model.assistantReply, '', ...right]
  const available = Math.max(1, height - header.length)
  const wide = !model.help && !model.full && model.stage !== 1 && width >= 90
  const leftWidth = wide ? Math.min(38, Math.floor(width * .36)) : 0
  const rightWidth = wide ? width - leftWidth - 3 : width
  const content = right.flatMap(line => wrapTextWithAnsi(clean(line), rightWidth))
  if (!model.help && !wide && !model.full && model.stage > 1 && scenario) content.unshift(...waves(scenario.steps).flat().map(step => fit(`${step.id === model.selected ? '›' : ' '} ${step.title} · ${model.stage === 3 ? model.run?.tasks[step.id]?.status ?? 'pending' : step.agent}`, width)), '─'.repeat(width))
  const scroll = Math.min(model.offset, Math.max(0, content.length - available))
  const rendered = content.slice(scroll, scroll + available)
  const result = [...header]
  for (let i = 0; i < available; i++) {
    const a = fit(left[i] ?? '', Math.max(1, leftWidth))
    result.push(wide ? a + ' '.repeat(Math.max(0, leftWidth - visibleWidth(a))) + ' │ ' + fit(rendered[i] ?? '', rightWidth) : fit(rendered[i] ?? '', width))
  }
  return result
}
