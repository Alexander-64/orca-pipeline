import { translate, type Language } from './i18n'

// The coordinator also serves older clients. Match its known diagnostic formats at the
// display boundary and retain original text for unknown errors and technical details.
const formats: [string, string][] = [
  ["agentPreferences.{0}: effort требует model", "agentPreferences.{0}: select a model before setting effort"],
  ["{0}: ожидается объект", "{0}: expected an object"],
  ["{0}: нужна непустая строка", "{0}: enter a non-empty string"],
  ["{0}: ожидается список строк", "{0}: expected a list of strings"],
  ["{0}: допустимо от 1 до 16", "{0}: use a value from 1 to 16"],
  ["steps[{0}].{1}: используйте version: 2 и декларативное when; approval остаётся ручным подтверждением", "steps[{0}].{1}: use version 2 and a when condition. Approval is a manual decision."],
  ["steps[{0}].id: используйте строчные буквы, цифры и дефис", "steps[{0}].id: use lowercase letters, digits and hyphens"],
  ["steps[{0}]: для remote нужен exact workspace selector или new-top-level", "steps[{0}]: remote execution requires an exact workspace selector or new-top-level"],
  ["steps[{0}]: для нового remote worktree нужен placement.repo", "steps[{0}]: a new remote worktree requires placement.repo"],
  ["steps[{0}].maxAttempts: допустимо от 1 до 3", "steps[{0}].maxAttempts: use a value from 1 to 3"],
  ["steps[{0}].maxRepairs: допустимо от 0 до 2", "steps[{0}].maxRepairs: use a value from 0 to 2"],
  ["steps[{0}].acceptance: нужна хотя бы одна проверка", "steps[{0}].acceptance: add at least one check"],
  ["steps[{0}].placement.setup: run, skip или inherit", "steps[{0}].placement.setup: use run, skip or inherit"],
  ["steps[{0}]: неизвестная роль {1}", "steps[{0}]: unknown role {1}"],
  ["steps.{0}: reviewAgent должен отличаться от исполнителя", "steps.{0}: select a different agent for review"],
  ["steps.{0}: {1} уже существует", "steps.{0}: {1} already exists"],
  ["steps: максимум 100 шагов с Evidence Gates", "steps: up to 100 steps including evidence gates"],
  ["scenario.version: поддерживаются версии 1 и 2", "scenario.version: supported versions are 1 and 2"],
  ["steps: нужен хотя бы один шаг", "steps: add at least one step"],
  ["steps: максимум 50 шагов", "steps: up to 50 steps allowed"],
  ["steps: повторяющийся id {0}", "steps: duplicate ID {0}"],
  ["steps.{0}: агент не должен повторяться в fallback", "steps.{0}: remove the duplicate fallback agent"],
  ["steps.{0}: неизвестная зависимость {1}", "steps.{0}: unknown dependency {1}"],
  ["steps.{0}: шаг зависит от себя", "steps.{0}: a step cannot depend on itself"],
  ["steps.{0}: effort требует model", "steps.{0}: select a model before setting effort"],
  ["steps: цикл зависимостей через {0}", "steps: dependency cycle through {0}"],
  ["quotaThreshold: допустимо от 1 до 100", "quotaThreshold: use a value from 1 to 100"],
  ["pullRequest.mergeApproval обязателен при merge", "pullRequest.mergeApproval is required to merge"],
  ["layout.{0}: координаты от 0 до 20000", "layout.{0}: coordinates must be between 0 and 20000"],
  ["Укажите true или false", "Enter true or false"],
  ["Укажите конечное число", "Enter a finite number"],
  ["Цикл или неизвестная зависимость", "Cycle or unknown dependency"],
  ["Неизвестный шаг: {0}", "Unknown step: {0}"],
  ["Неизвестный шаг связи", "Unknown step in this connection"],
  ["Интеграция Beads выключена. Задачи pipeline доступны без неё.", "Beads is disabled. Built-in pipeline tasks are available."],
  ["Workspace не найден", "Workspace not found"],
  ["Редактор планов пока открывает локальные проекты", "The plan editor currently opens local projects"],
  ["Выберите проект", "Choose a project"],
  ["Откройте редактор из проекта в Agent Pipeline", "Open the editor from a project in Agent Pipeline"],
  ["Опишите задачу для planner", "Describe the task for the planner"],
  ["У этого старого плана нет отдельного документа. Откройте текущий сценарий кнопкой редактора.", "This older plan has no separate document. Use Open editor in a tab to open the current scenario."],
  ["Выберите доступный workspace", "Choose an available workspace"],
  ["В заданиях разрешена работа только в {0}. Выберите «Работать в указанной папке» или измените ограничения перед созданием отдельного workspace.", "The instructions restrict work to {0}. Choose Use the required folder or edit the instructions before creating a separate workspace."],
  ["Запуск {0} не найден", "Run {0} not found"],
  ["Попытка не принадлежит этому запуску", "This attempt belongs to a different run"],
  ["Восстановление Pi-контекста доступно для консольных запусков", "Pi context recovery is available for terminal runs"],
  ["Сейчас восстанавливается другой прогон. Дождитесь результата.", "Another run is being recovered. Wait for it to finish."],
  ["Проверяю журнал запуска и фактических исполнителей.", "Checking the launch journal against active agent sessions."],
  ["Консольный прогон: {0}.", "Terminal run: {0}."],
  ["Прогон уже завершён.", "This run has already finished."],
  ["Прогон отменён. Для нового выполнения создайте новый прогон.", "This run was cancelled. Select New run to start again."],
  ["{0}: {1} выключен; использую резервного {2}.", "{0}: {1} is disabled. Switching to fallback agent {2}."],
  ["Прогон продолжен с сохранёнными результатами завершённых шагов.", "Run resumed. Completed step results are saved."],
  ["Прогон завершён.", "Run completed."],
  ["Нужно ваше решение по подтверждению шага.", "This step needs your approval."],
  ["Агенту нужен ответ: {0}", "Agent needs a reply: {0}"],
  ["Продолжение требует дополнительных данных. Откройте проблемный шаг.", "Open the affected step to see what is needed to continue."],
  ["Переключите активного исполнителя из консоли после подтверждённой остановки", "Switch the active agent from the terminal after its stop is confirmed"],
  ["Дождитесь завершения диагностики прогона.", "Wait for the run diagnosis to finish."],
  ["Команда вернула не JSON: {0}", "Command returned invalid JSON: {0}"],
  ["Orca завершила команду с кодом {0}: {1}", "Orca command exited with code {0}: {1}"],
  ["Не удалось восстановить mutation {0}", "Could not recover operation {0}"],
  ["Orca не подтвердила mutation {0}: {1}", "Orca could not confirm operation {0}: {1}"],
  ["Не удалось автоматически сверить операцию {0}: требуется подтверждение её результата.", "Could not reconcile operation {0} automatically. Its outcome needs confirmation."],
  ["Операция {0} не сопоставлена единственной сохранённой задаче.", "Operation {0} could not be matched to one saved task."],
  ["Сохранённая операция не соответствует агенту и рабочей папке шага.", "The saved operation does not match the step’s agent and working folder."],
  ["Orca не вернула полный список исполнителей; восстановление остановлено.", "Orca returned an incomplete agent list. Recovery stopped."],
  ["Для задачи обнаружены несколько неизвестных исполнителей. Повторный запуск не выполнялся.", "Several unknown workers match this task. Recovery left the task paused."],
  ["Агент найденного исполнителя не соответствует настроенной цепочке шага.", "The worker’s agent does not match the configured agent chain."],
  ["Агент найденного исполнителя не соответствует сохранённой операции.", "The worker’s agent does not match the saved launch."],
  ["У найденного исполнителя нет подтверждённого Dispatch ID.", "The existing worker has no confirmed dispatch ID."],
  ["Найденный исполнитель ещё не подтвердил приём задания.", "The existing worker has not confirmed receipt of the task."],
  ["{0}: найден уже запущенный исполнитель; повтор не создавался.", "{0}: adopted the existing agent session."],
  ["{0}: не подтверждено, что задача свободна для запуска.", "{0}: the task has not been confirmed available for launch."],
  ["Исходное окно изменилось или ожидает действия пользователя. Новое окно не создавалось.", "The original session changed or is waiting for user input. Check the existing session."],
  ["{0}: восстановлено исходное окно агента.", "{0}: restored the original agent session."],
  ["{0}: подтверждено, что задание не было запущено.", "{0}: confirmed the task had not started."],
  ["Отдельный Pipeline workspace пока доступен для локального Git-проекта. Выберите локальный проект или отключите отдельный workspace.", "A separate Pipeline workspace requires a local Git project. Select a local project or turn off the separate workspace."],
  ["Нужен Git workspace для создания Pipeline. Для обычной папки отключите отдельный workspace.", "Creating a Pipeline workspace requires Git. For a plain folder, turn off the separate workspace."],
  ["Orca не вернула созданный workspace; проверьте левое меню перед повторным запуском.", "Orca did not return the created workspace. Check the sidebar before retrying."],
  ["У шага уже есть незавершённый или непроверенный запуск. Откройте его окно перед повтором.", "This step already has an unfinished or unconfirmed launch. Check its session before retrying."],
  ["Этот запуск создан фоновым агентом Orca. Его вывод доступен в истории попыток; новые локальные запуски открывают видимые окна.", "This run used an Orca background agent. Its output is in the attempt history. New local runs open visible sessions."],
  ["Orca не вернула Run ID", "Orca did not return a run ID"],
  ["Orca не вернула Task ID для {0}", "Orca did not return a task ID for {0}"],
  ["Orca не вернула Gate ID для {0}", "Orca did not return a gate ID for {0}"],
  ["Remote {0} не готов: {1}", "Remote {0} is unavailable: {1}"],
  ["Remote {0} не поддерживает model/effort для orchestration", "Remote {0} does not support model or effort selection for orchestration"],
  ["Исходное окно агента изменилось или недоступно. Повторный запуск не отправлен.", "The original agent session changed or is unavailable. Check before retrying."],
  ["Сначала закройте меню в окне агента: {0}", "Close the menu in the agent session first: {0}"],
  ["Orca не вернула handle видимого агента; проверьте workspace перед повторной попыткой.", "Orca did not return a visible agent session handle. Check the workspace before retrying."],
  ["Orca не вернула Dispatch ID для {0}: {1}", "Orca did not return a dispatch ID for {0}: {1}"],
  ["Выберите открытый вопрос активного агента и введите ответ", "Select a waiting agent question and enter a reply"],
  ["Вопрос не принадлежит текущей попытке этого шага", "This question belongs to another attempt"],
  ["Для изменённого ответа нужен новый message ID", "A changed reply needs a new message ID"],
  ["На этот вопрос уже ответили; новый ответ не отправлен", "This question has already been answered"],
  ["Запуск консоли не найден в выбранном проекте", "Terminal run not found in the selected project"],
  ["Откройте консоль pipeline в этом проекте для управления запуском. Работа не перезапускалась.", "Open the pipeline terminal in this project to control the existing run."],
  ["Ответ консоли не соответствует запуску", "The terminal response belongs to another run"],
  ["Ответ консоли не соответствует сообщению", "The terminal response belongs to another message"],
  ["Planner не вернул fenced YAML-блок", "The planner returned no fenced YAML block"],
  ["Planner {0} не найден", "Planner {0} not found"],
  ["Опишите цель для planner", "Enter a planner objective"],
  ["acceptance: пустая команда", "acceptance: empty command"],
  ["acceptance: destructive команда запрещена: {0}", "acceptance: destructive command rejected: {0}"],
  ["acceptance: сетевая команда требует отдельного разрешения: {0}", "acceptance: network command requires permission: {0}"],
  ["acceptance: команда не разрешена в read-only режиме: {0}", "acceptance: command unavailable in read-only mode: {0}"],
  ["acceptance: команда отсутствует в allowlist: {0}", "acceptance: command missing from the allowlist: {0}"],
]
const messages = formats.map(([original, english]) => ({ parts: original.split(/\{\d+\}/), english }))

export function diagnosticText(language: Language, raw?: string | null): string {
  if (!raw || language === 'ru') return raw ?? ''
  const prefix = raw.startsWith('Error: ') ? 'Error: ' : ''
  const input = raw.slice(prefix.length)
  for (const { parts, english } of messages) {
    if (parts.length === 1) {
      if (input === parts[0]) return prefix + english
      continue
    }
    if (!input.startsWith(parts[0]) || !input.endsWith(parts[parts.length - 1])) continue
    let offset = parts[0].length
    const values: string[] = []
    for (let index = 1; index < parts.length; index++) {
      const delimiter = parts[index]
      const end = index === parts.length - 1 ? input.length - delimiter.length : input.indexOf(delimiter, offset)
      if (end < offset) break
      values.push(input.slice(offset, end))
      offset = end + delimiter.length
    }
    if (values.length === parts.length - 1) return prefix + english.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)])
  }
  return raw
}

// New diagnostics carry an ID and typed data. Legacy journal strings go through diagnosticText.
export type PanelDiagnostic =
  | { id: 'catalog.unsupported'; agent: string }
  | { id: 'attempt.checkFailed'; command: string; exitCode: number | null }

export function renderDiagnostic(language: Language, diagnostic: PanelDiagnostic): string {
  switch (diagnostic.id) {
    case 'catalog.unsupported':
      return translate(language, 'This Orca build cannot supply model choices for {0}. Use the agent default or update Orca.', diagnostic.agent)
    case 'attempt.checkFailed':
      return diagnostic.exitCode === null
        ? translate(language, 'Check did not report an exit code: {0}', diagnostic.command)
        : translate(language, 'Check failed (exit {0}): {1}', diagnostic.exitCode, diagnostic.command)
  }
}
