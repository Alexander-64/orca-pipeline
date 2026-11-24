import { ProcessTerminal, TuiAltScreen, Input, matchesKey, isKeyRelease, type Component } from '@earendil-works/pi-tui'
import { readFile, realpath, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../runtime/config'
import { request, type Request } from '../runtime/supervisor'
import { parseScenario, serializeScenario } from '../core/scenario'
import { waves } from '../core/editor'
import type { PipelineRun, MessageReceipt } from '../core/types'
import { commandArgs } from '../runtime/acceptance'
import { createPlan } from './planning'
import { runConsoleAgent } from './agent'
import { renderView, setStage, editScenario, interactionCommand, type ViewModel } from './view'
import { redactSecrets } from '../core/failover'
import { SavedProjects, nativeProjects } from './projects'
import { OrcaClient } from '../../src/cli'

export async function launchTui(initialProject: string, ensureSupervisor: (project: string) => Promise<void>, initialBackend?: 'local' | 'orca'): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive UI requires a terminal. Use plan/run/status --json for automation.')
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false })
  const input = new Input({ prompt: '> ', placeholder: 'Задача или :команда' }); input.focused = true
  const model: ViewModel = { project: initialProject, stage: 1, goal: '', offset: 0, follow: true, activity: {} }
  let config = await loadConfig(model.project), after = 0, polling = false, busy = false, closed = false
  let backendOverride = initialBackend
  if (backendOverride) config.backend = backendOverride
  model.backend = config.backend ?? 'local'
  const resolver = () => new SavedProjects(undefined, config.backend === 'orca' ? () => nativeProjects(new OrcaClient(undefined, config.orca?.executable)) : undefined)
  try { model.projects = await resolver().list() } catch (error) { model.message = (error as Error).message }
  let planner: AbortController | undefined
  let consoleSessionFile: string | undefined
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const paint = () => { tui.requestRender() }
  const call = async (message: Omit<Request, 'id'>) => { await ensureSupervisor(model.project); return request(model.project, { id: randomUUID(), ...message }) }
  const detach = () => { if (closed) return; closed = true; planner?.abort(); clearInterval(timer); tui.stop(); finish() }
  const updateSelection = (delta: number) => {
    const steps = waves((model.stage === 3 ? model.run?.scenario : model.scenario)?.steps ?? []).flat()
    if (!steps.length) return
    const index = steps.findIndex(step => step.id === model.selected)
    model.selected = steps[(Math.max(0, index) + delta + steps.length) % steps.length].id
    model.follow = false; model.offset = 0
    model.assistantReply = undefined
  }
  const save = async () => {
    if (!model.scenario || !model.file) throw new Error('Нет открытого сценария')
    const disk = await readFile(model.file, 'utf8')
    if (disk !== model.source) throw new Error('Файл изменён другим редактором. Откройте его заново через :open')
    const source = serializeScenario(model.scenario)
    const path = model.file + '.' + randomUUID() + '.tmp'
    await writeFile(path, source, { flag: 'wx', mode: 0o600 }); await rename(path, model.file); model.source = source
  }
  const generate = async (goal: string) => {
    planner = new AbortController(); model.busy = 'Planner изучает проект…'; paint()
    const plan = await createPlan(model.project, config, goal, planner.signal, event => { model.busy = event.tool ? 'Planner: ' + event.tool : 'Planner составляет сценарий…'; paint() })
    model.goal = goal; model.scenario = plan.scenario; model.source = plan.source; model.file = plan.file; model.selected = plan.scenario.steps[0].id
    setStage(model, 2); model.message = 'Сценарий сохранён. Проверьте шаги; :run — запуск.'
  }
  const dispatch = async (line: string) => {
    if (!line.startsWith(':')) {
      if (model.stage === 1) { await generate(line); return }
      planner = new AbortController(); model.busy = 'Помощник проверяет состояние…'; paint()
      const previousRun = model.run?.id, previousSource = model.source
      const result = await runConsoleAgent(model.project, config, line, { file: model.file, source: model.source, runId: model.run?.id, sessionFile: consoleSessionFile,
        signal: planner.signal, call: async message => { await ensureSupervisor(model.project); return request(model.project, message) },
        onEvent: event => { if (event.tool) model.busy = 'Помощник: ' + event.tool; paint() } })
      consoleSessionFile = result.sessionFile
      if (result.source && result.file) { model.source = result.source; model.file = result.file; model.scenario = parseScenario(result.source, { expandEvidence: false }); if (result.source !== previousSource) setStage(model, 2) }
      if (result.run) { model.run = result.run; if (result.run.id !== previousRun) setStage(model, 3) }
      model.assistantReply = result.text; model.message = 'Ответ помощника · :send — написать исполнителю'; model.offset = 0
      return
    }
    const interaction = interactionCommand(line, model.run?.tasks[model.selected ?? '']?.questions?.find(question => question.state === 'waiting')?.id)
    if (interaction) {
      if (!model.run || !model.selected || model.stage !== 3) throw new Error('Выберите работающего агента на этапе 3')
      const result = await call({ command: 'send', runId: model.run.id, stepId: model.selected, ...interaction }) as { receipt: MessageReceipt; run: PipelineRun }
      model.run = result.run; model.message = `Сообщение ${result.receipt.id}: ${result.receipt.state}. Доставка появится в статусе шага.`
      return
    }
    const [command, ...args] = commandArgs(line.slice(1))
    if (command === 'help') { model.help = !model.help; model.offset = 0; return }
    if (command === 'next') { setStage(model, Math.min(3, model.stage + 1) as 1 | 2 | 3); return }
    if (command === 'back') { setStage(model, Math.max(1, model.stage - 1) as 1 | 2 | 3); return }
    if (command === 'full') { model.full = !model.full; return }
    if (command === 'yaml') { model.yaml = !model.yaml; model.offset = 0; return }
    if (command === 'follow') { model.follow = true; return }
    if (command === 'backend') {
      if (!['local', 'orca'].includes(args[0])) throw new Error(':backend local или :backend orca')
      config.backend = args[0] as 'local' | 'orca'; backendOverride = config.backend; model.backend = config.backend
      model.projects = await resolver().list(); model.message = 'Следующий запуск: ' + config.backend; return
    }
    if (command === 'projects') { model.projects = await resolver().list(); model.offset = 0; model.message = ':project номер, имя или полный путь'; return }
    if (command === 'project') {
      if (model.run && ['running', 'paused'].includes(model.run.status)) throw new Error('Отсоединитесь от текущего запуска перед сменой проекта')
      const project = await resolver().resolve(args.join(' '), model.projects)
      const selectedConfig = await loadConfig(project.path)
      await resolver().remember(project)
      model.project = project.path; config = selectedConfig
      if (backendOverride) config.backend = backendOverride
      model.backend = config.backend ?? 'local'
      consoleSessionFile = undefined; model.assistantReply = undefined
      model.projects = await resolver().list()
      model.stage = 1; model.scenario = undefined; model.source = undefined; model.run = undefined; model.goal = ''; model.file = undefined; after = 0; model.activity = {}; return
    }
    if (command === 'open') {
      const file = resolve(model.project, args.join(' ')); const source = await readFile(file, 'utf8'); const scenario = parseScenario(source, { expandEvidence: false })
      model.file = file; model.source = source; model.scenario = scenario; model.selected = scenario.steps[0].id; setStage(model, 2); return
    }
    if (command === 'edit') {
      if (!model.file) throw new Error('Сначала откройте или составьте план')
      const [editor, ...editorArgs] = commandArgs(process.env.VISUAL || process.env.EDITOR || 'vi')
      tui.stop()
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(editor, [...editorArgs, model.file!], { stdio: 'inherit' })
          child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Редактор завершился с ошибкой')))
        })
        const source = await readFile(model.file, 'utf8'); const scenario = parseScenario(source, { expandEvidence: false })
        model.source = source; model.scenario = scenario; model.selected = scenario.steps[0].id
      } finally { tui.start(); paint() }
      return
    }
    if (command === 'run') {
      if (!model.source || !model.scenario) throw new Error('Сначала составьте сценарий')
      if (model.file && await readFile(model.file, 'utf8') !== model.source) throw new Error('Сценарий изменён на диске. Выполните :open')
      if (model.run && ['running', 'paused'].includes(model.run.status)) throw new Error('Текущий запуск ещё активен')
      model.run = await call({ command: 'run', source: model.source, backend: config.backend ?? 'local' }) as PipelineRun
      setStage(model, 3); model.follow = true; return
    }
    if (['pause', 'resume', 'stop', 'retry', 'recover', 'reconcile', 'approve', 'reject', 'window'].includes(command)) {
      if (!model.run) throw new Error('Нет выбранного запуска')
      model.run = await call({ command: command === 'reject' ? 'approve' : command === 'window' ? 'open' : command, runId: model.run.id, stepId: args[0] ?? model.selected, resolution: command === 'reject' ? 'reject' : 'approve' }) as PipelineRun
      return
    }
    if (command === 'attach') {
      const result = await call({ command: 'status', runId: args[0] }) as { runs: PipelineRun[] }
      const run = args[0] ? result.runs.find(run => run.id === args[0]) : result.runs[0]
      if (!run) throw new Error('Запуск не найден')
      model.run = run; model.scenario = run.scenario; model.selected = run.scenario.steps[0].id; setStage(model, 3); return
    }
    if (model.stage !== 2 || !model.scenario) throw new Error('Редактирование доступно на этапе 2')
    const previous = model.scenario
    model.scenario = editScenario(previous, line.slice(1), Object.keys(config.executors))
    try { await save() } catch (error) { model.scenario = previous; throw error }
    model.message = 'Изменения сохранены. Текущий запуск использует свой снимок сценария.'
  }
  input.onSubmit = value => {
    input.setValue('')
    if (value.trim() === ':detach') { detach(); return }
    if (busy) { model.message = 'Дождитесь текущей операции; Ctrl+C отменяет planner, :detach выходит.'; paint(); return }
    if (!value.trim()) return
    busy = true
    void dispatch(value.trim()).catch(error => { model.message = redactSecrets(error instanceof Error ? error.message : String(error)) })
      .finally(() => { busy = false; model.busy = undefined; planner = undefined; paint() })
  }
  const app: Component = {
    focused: true,
    invalidate() {},
    render(width: number) { return [...renderView(model, width, terminal.rows - 2), ...input.render(width)] },
    handleInput(data: string) {
      if (isKeyRelease(data)) return
      if (matchesKey(data, 'ctrl+d')) { detach(); return }
      if (matchesKey(data, 'ctrl+c')) { if (planner) planner.abort(); else { input.setValue(''); model.message = 'Запуск продолжает работать. :stop — остановить, :detach — выйти.' }; paint(); return }
      try {
        if (matchesKey(data, 'escape') && (model.help || model.full || model.yaml)) { model.help = false; model.full = false; model.yaml = false; model.offset = 0 }
        else if (matchesKey(data, 'f1')) setStage(model, 1)
        else if (matchesKey(data, 'f2')) setStage(model, 2)
        else if (matchesKey(data, 'f3')) setStage(model, 3)
        else if (matchesKey(data, 'up') && model.stage > 1) updateSelection(-1)
        else if (matchesKey(data, 'down') && model.stage > 1) updateSelection(1)
        else if (matchesKey(data, 'pageUp')) model.offset = Math.max(0, model.offset - Math.max(1, terminal.rows - 7))
        else if (matchesKey(data, 'pageDown')) model.offset += Math.max(1, terminal.rows - 7)
        else input.handleInput(data)
      } catch (error) { model.message = (error as Error).message }
      paint()
    }
  } as Component
  tui.addChild(app); tui.setFocus(app)
  const timer = setInterval(() => {
    if (polling || closed || !model.run || busy) return
    polling = true
    void call({ command: 'status', after, runId: model.run.id }).then(value => {
      const previous = JSON.stringify({ run: model.run, selected: model.selected, activity: model.activity })
      const dashboard = value as { runs: PipelineRun[]; events: { seq: number; at: string; data: { taskId?: string; kind?: string; tool?: string } }[] }
      model.run = dashboard.runs.find(run => run.id === model.run?.id) ?? model.run
      after = dashboard.events.at(-1)?.seq ?? after
      for (const event of dashboard.events) {
        const task = Object.values(model.run!.tasks).find(task => task.taskId === event.data?.taskId)
        if (task && event.data.kind) model.activity[task.stepId] = `${event.data.kind}${event.data.tool ? ': ' + event.data.tool : ''} · ${event.at}`
      }
      if (model.follow) model.selected = model.run?.scenario.steps.find(step => ['running', 'retrying'].includes(model.run!.tasks[step.id]?.status))?.id ?? model.selected
      if (previous !== JSON.stringify({ run: model.run, selected: model.selected, activity: model.activity })) paint()
    }).catch(error => { model.message = redactSecrets(error.message); paint() }).finally(() => { polling = false })
  }, 500)
  tui.start(); await done
  console.log('Отсоединено. Работающие шаги продолжаются. Возврат: pipeline ui --project ' + JSON.stringify(model.project) + ' → :attach')
}
