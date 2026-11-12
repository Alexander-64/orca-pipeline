import {
  atom,
  Badge,
  Box,
  Grid,
  Checkbox,
  Button,
  Callout,
  Card,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  KeyValue,
  List,
  ListItem,
  plugin,
  Progress,
  read,
  Row,
  RadioGroup,
  Select,
  Separator,
  set,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { agentOptions } from './agents'
import { parseScenario, serializeScenario } from './scenario'
import { waves, validateGraph, patchStep, insertStep, deleteStep } from './editor'
import { SCENARIO_TEMPLATES } from './templates'
import { DEFAULT_SCENARIO, type Dashboard, type PipelineRun, type PlannerRun, type Scenario, type StepStatus } from './types'

const tab = atom('pipeline.tab', 'scenario', { persist: 'plugin' })
const draft = atom('pipeline.draft', DEFAULT_SCENARIO, { persist: 'plugin' })
const workspaceId = atom('pipeline.workspace', '', { persist: 'plugin' })
const runId = atom('pipeline.run', '', { persist: 'plugin' })
const stepId = atom('pipeline.step', '', { persist: 'plugin' })
const objective = atom('pipeline.objective', '', { persist: 'plugin' })
const plannerAgent = atom('pipeline.planner-agent', 'codex', { persist: 'plugin' })
const viewMode = atom('pipeline.editor-view', 'split', { persist: 'plugin' })
const appliedPlans = atom<string[]>('pipeline.applied-plans', [], { persist: 'plugin' })
const scenarioName = atom('')
const scenarioObjective = atom('')
const plan = atom<PlannerRun | null>(null)
const validated = atom<Scenario | null>(null)
const editorSelection = atom('')
const inspector = atom<Scenario['steps'][number] | null>(null)
const draftError = atom<string | null>(null)
const editError = atom<string | null>(null)
const template = atom('pipeline.template', 'custom', { persist: 'plugin' })
const beadSearch = atom('pipeline.bead-search', '', { persist: 'plugin' })
const beadStatus = atom('pipeline.bead-status', 'all', { persist: 'plugin' })
const beadEpic = atom('pipeline.bead-epic', 'all', { persist: 'plugin' })
const data = atom<Dashboard | null>(null)
const busy = atom(false)
const error = atom<string | null>(null)

const STATUS: Record<StepStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  pending: { label: 'Ожидает', tone: 'neutral' },
  ready: { label: 'Готов', tone: 'accent' },
  running: { label: 'Выполняется', tone: 'accent' },
  retrying: { label: 'Переключение', tone: 'warning' },
  done: { label: 'Готово', tone: 'success' },
  failed: { label: 'Ошибка', tone: 'danger' },
  blocked: { label: 'Заблокирован', tone: 'warning' },
  superseded: { label: 'Заменено', tone: 'neutral' }
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function selectNode(id: string): void {
  set(editorSelection, id)
  set(inspector, read(validated)?.steps.find(step => step.id === id) ?? null)
  set(editError, null)
}

function syncDraft(source: string): void {
  set(draft, source)
  try {
    parseScenario(source)
    const scenario = parseScenario(source, { expandEvidence: false })
    set(validated, scenario)
    set(scenarioName, scenario.name)
    set(scenarioObjective, scenario.objective)
    set(draftError, null)
    selectNode(scenario.steps.some(step => step.id === read(editorSelection)) ? read(editorSelection) : scenario.steps[0].id)
  } catch (value) {
    set(draftError, message(value))
  }
}

function mutateGraph(operation: (scenario: Scenario) => Scenario, selectLast = false): void {
  const scenario = read(validated)
  if (!scenario || read(draftError)) return
  try {
    const next = validateGraph(operation(scenario))
    syncDraft(serializeScenario(next))
    if (selectLast) selectNode(next.steps.at(-1)!.id)
    set(editError, null)
  } catch (value) {
    set(editError, message(value))
  }
}

function updateInspector(patch: Partial<Scenario['steps'][number]>): void {
  update(inspector, step => step ? { ...step, ...patch } : step)
}

function receivePlan(next: PlannerRun): void {
  if (next.workspaceId && next.workspaceId !== read(workspaceId)) return
  const current = read(plan)
  if (current && current.id !== next.id && current.createdAt && next.createdAt && current.createdAt > next.createdAt) return
  if (current?.id === next.id && current.status !== 'running' && next.status === 'running') return
  if (next.status === 'done' && next.source && !read(appliedPlans).includes(next.id)) {
    try {
      parseScenario(next.source)
      parseScenario(next.source, { expandEvidence: false })
      syncDraft(next.source)
      set(appliedPlans, [...read(appliedPlans), next.id])
    } catch (value) {
      set(error, message(value))
      return
    }
  }
  set(plan, next)
}

function PlannerSummary() {
  const current = read(plan)
  if (!current) return null
  let summary: Scenario | null = null
  try { if (current.source) summary = parseScenario(current.source, { expandEvidence: false }) } catch {}
  return <Card title="Planner">
    <Stack gap="xs">
      <Badge tone={current.status === 'failed' ? 'danger' : current.status === 'done' ? 'success' : 'accent'}>{current.status}</Badge>
      <KeyValue items={[
        { label: 'Цель planner', value: current.objective ?? read(objective) },
        { label: 'Агент planner', value: current.agent },
        { label: 'Run ID', value: current.runId }
      ]} />
      {current.error ? <Callout title="Planner error" tone="danger"><Text>{current.error}</Text></Callout> : null}
      {summary ? <KeyValue items={[
        { label: 'Scenario name', value: summary.name },
        { label: 'Scenario objective', value: summary.objective },
        { label: 'Шагов', value: summary.steps.length },
        { label: 'Волн', value: waves(summary.steps).length }
      ]} /> : null}
    </Stack>
  </Card>
}

async function refresh(selected?: string): Promise<void> {
  const id = selected ?? read(workspaceId)
  try {
    const answer = await plugin.request('dashboard.get', id ? { workspaceId: id } : {})
    set(data, answer)
    if (!id && answer.workspaces[0]) set(workspaceId, answer.workspaces[0].id)
    set(error, null)
    const latest = answer.plans?.at(-1)
    if (latest) receivePlan(latest)
  } catch (value) {
    set(error, message(value))
  }
}

async function action(callback: () => Promise<void>): Promise<void> {
  set(busy, true)
  set(error, null)
  try {
    await callback()
  } catch (value) {
    set(error, message(value))
  } finally {
    set(busy, false)
  }
}

async function generatePlan(): Promise<void> {
  await action(async () => {
    const id = read(workspaceId)
    if (!id) throw new Error('Выберите workspace')
    const answer = await plugin.request('plan.start', {
      workspaceId: id,
      objective: read(objective),
      agent: read(plannerAgent)
    })
    receivePlan(answer.plan)
  })
}

async function start(): Promise<void> {
  await action(async () => {
    const id = read(workspaceId)
    if (!id) throw new Error('Выберите workspace')
    const { run } = await plugin.request('run.start', { workspaceId: id, source: read(draft) }, { timeoutMs: 120_000 })
    set(runId, run.id)
    set(tab, 'runs')
    update(data, (previous) => previous ? { ...previous, runs: [run, ...previous.runs.filter((item) => item.id !== run.id)] } : previous)
  })
}

async function runCommand(kind: 'pause' | 'resume' | 'retry' | 'cancel' | 'tick', id: string): Promise<void> {
  await action(async () => {
    const request = kind === 'pause' ? 'run.pause' : kind === 'resume' ? 'run.resume' : kind === 'retry' ? 'run.retry' : kind === 'cancel' ? 'run.cancel' : 'run.tick'
    const { run } = await plugin.request(request, { id })
    update(data, (previous) => previous ? { ...previous, runs: previous.runs.map((item) => item.id === id ? run : item) } : previous)
  })
}

async function changeBead(id: string, beadAction: 'claim' | 'close' | 'reopen'): Promise<void> {
  await action(async () => {
    const answer = await plugin.request('beads.action', { workspaceId: read(workspaceId), id, action: beadAction })
    set(data, answer)
  })
}

function statusBadge(status: StepStatus) {
  const item = STATUS[status]
  return <Badge tone={item.tone}>{item.label}</Badge>
}

function selectedRun(): PipelineRun | undefined {
  const dashboard = read(data)
  return dashboard?.runs.find((run) => run.id === read(runId)) ?? dashboard?.runs[0]
}

function StepEditor() {
  const step = read(inspector)
  const scenario = read(validated)
  if (!step || !scenario) return null
  const locked = !!read(draftError)
  return <Card title={`Inspector · ${step.id}`}>
    <Stack gap="sm">
      <Input label="Название шага" value={step.title} onChange={title => updateInspector({ title })} />
      <Textarea label="Задание шага" rows={4} value={step.spec} onChange={spec => updateInspector({ spec })} />
      <Select label={`Agent ${step.id}`} value={step.agent}
        options={agentOptions(read(data)?.agents, [step.agent])}
        onChange={agent => updateInspector({ agent, fallback: step.fallback.filter(value => value !== agent), reviewAgent: step.reviewAgent === agent ? undefined : step.reviewAgent })} />
      <Text size="sm">Fallback · порядок выбора задаёт порядок попыток</Text>
      {agentOptions(read(data)?.agents, step.fallback).filter(option => option.value !== step.agent).map(option => <Checkbox
        label={`Fallback ${step.id}: ${option.label}`} checked={step.fallback.includes(option.value)}
        onChange={checked => updateInspector({ fallback: checked ? [...step.fallback, option.value] : step.fallback.filter(id => id !== option.value) })} />)}
      <Select label="Review agent" value={step.reviewAgent ?? 'none'}
        options={[{ value: 'none', label: 'Без Evidence Gate' }, ...agentOptions(read(data)?.agents, [step.reviewAgent ?? '']).filter(option => option.value !== step.agent)]}
        onChange={value => updateInspector({ reviewAgent: value === 'none' ? undefined : value })} />
      <Textarea label="Acceptance — команда на строку" rows={3} value={step.acceptance.join('\n')} onChange={value => updateInspector({ acceptance: value.split('\n').filter(item => item.trim()) })} />
      <Text size="sm">Зависимости · дождаться завершения</Text>
      {scenario.steps.filter(candidate => candidate.id !== step.id).map(candidate => <Checkbox
        label={`После ${candidate.id}`} checked={step.needs.includes(candidate.id)}
        onChange={checked => updateInspector({ needs: checked ? [...step.needs, candidate.id] : step.needs.filter(id => id !== candidate.id) })} />)}
      {scenario.steps.length === 1 ? <Text muted>Других шагов пока нет</Text> : null}
      <Text muted size="xs">Изменения применяются кнопкой; циклы и некорректные настройки будут отклонены.</Text>
      <Row gap="xs" wrap>
        <Button disabled={locked} onPress={() => mutateGraph(graph => patchStep(graph, step.id, step))}>Применить шаг</Button>
        <Button variant="ghost" onPress={() => selectNode(step.id)}>Сбросить поля</Button>
        <Button variant="ghost" tone="danger" disabled={locked || scenario.steps.length === 1} onPress={() => mutateGraph(graph => deleteStep(graph, step.id))}>Удалить {step.id}</Button>
      </Row>
    </Stack>
  </Card>
}

function GraphEditor() {
  const scenario = read(validated)
  if (!scenario) return null
  const layers = waves(scenario.steps)
  const locked = !!read(draftError)
  return <Stack gap="sm">
    <Row gap="sm" wrap>
      <Heading level={2}>DAG-редактор</Heading>
      <Badge>{scenario.steps.length} шагов</Badge><Badge>{layers.length} волн</Badge>
      <Badge>{new Set(scenario.steps.map(step => step.agent)).size} агентов</Badge>
      <Button size="sm" variant="outline" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph), true)}>Добавить шаг</Button>
      <Button size="sm" variant="outline" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, read(editorSelection)), true)}>Добавить дочерний</Button>
      <Button size="sm" variant="ghost" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, undefined, read(editorSelection)), true)}>Дублировать</Button>
    </Row>
    <Grid minItemWidth="lg" gap="md">
      <Stack gap="md">
        {layers.map((layer, index) => <Stack gap="sm">
          <Heading level={3}>{`Волна ${index + 1} · ${layer.length === 1 ? 'последовательно' : 'параллельно'}`}</Heading>
          <Grid minItemWidth="sm" gap="sm">
            {layer.map(step => <Box padding="sm" radius="md" border={read(editorSelection) === step.id ? 'accent' : true} background={read(editorSelection) === step.id ? 'accent' : 'card'}>
              <Button size="sm" variant="ghost" onPress={() => selectNode(step.id)}>{step.title}</Button>
              <Text size="xs">{step.id} · {step.agent}</Text>
              {read(editorSelection) === step.id ? <Badge tone="accent">Выбран</Badge> : null}
              <Text size="sm">{step.needs.length ? `После: ${step.needs.join(', ')}` : 'Независимый старт'}</Text>
              <Row gap="xs" wrap>
                {step.fallback.length ? <Badge tone="warning">{`Fallback: ${step.fallback.join(' → ')}`}</Badge> : null}
                {step.reviewAgent ? <Badge tone="accent">{`Evidence Gate: ${step.reviewAgent}`}</Badge> : null}
                {step.approval ? <Badge tone="warning">Approval</Badge> : null}
                {step.placement.host !== 'local' ? <Badge tone="accent">{`Remote: ${step.placement.host}`}</Badge> : null}
              </Row>
            </Box>)}
          </Grid>
        </Stack>)}
      </Stack>

    </Grid>
  </Stack>
}

function ScenarioView() {
  const dashboard = read(data)
  const disabled = read(busy) || !dashboard?.workspaces.length
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={2}>Новый pipeline</Heading>
        <Text muted size="sm">YAML → Orca DAG → проверка → Beads. Запуск не меняет сценарий после старта.</Text>
      </Stack>
      <Grid minItemWidth="sm" gap="sm">
        <Select
          label="Workspace"
          value={read(workspaceId)}
          options={dashboard?.workspaces.map((workspace) => ({ value: workspace.id, label: `${workspace.name} · ${workspace.branch ?? workspace.kind}` })) ?? []}
          placeholder="Выберите workspace"
          onChange={(value) => {
            set(workspaceId, value)
            set(plan, null)
            void refresh(value)
          }}
        />
        <Select
          label="Шаблон"
          value={read(template)}
          options={[
            { value: 'custom', label: 'Свой сценарий' },
            { value: 'implement-review', label: 'Реализация → Evidence Gate' },
            { value: 'bugfix-regression', label: 'Bugfix → regression test' },
            { value: 'research-design', label: 'Research → design → implementation' }
          ]}
          onChange={(value) => {
            set(template, value)
            if (value !== 'custom') {
              syncDraft(SCENARIO_TEMPLATES[value])
            }
          }}
        />
      </Grid>
      <Row gap="sm" wrap>
        <Button
          variant="outline"
          icon="check"
          disabled={read(busy)}
          onPress={() => action(async () => {
            await plugin.request('scenario.validate', { source: read(draft) })
            syncDraft(read(draft))
          })}
        >Проверить YAML</Button>
        <Button icon="play" disabled={disabled} onPress={start}>Запустить</Button>
        <Button variant="ghost" icon="refresh" disabled={read(busy)} onPress={() => refresh()}>Обновить</Button>
      </Row>
      {read(draftError) ? <Callout tone="danger" title="YAML невалиден · показан последний валидный DAG"><Text>{read(draftError)}</Text></Callout> : null}
      {read(editError) ? <Callout tone="danger" title="Изменение не применено"><Text>{read(editError)}</Text></Callout> : null}
      <PlannerSummary />
      <Card title={read(validated)?.name ?? 'Сценарий'} description={read(validated)?.objective}>
        <Stack gap="sm">
          <Input label="Scenario name" value={read(scenarioName)} onChange={value => set(scenarioName, value)} />
          <Textarea label="Scenario objective" rows={2} value={read(scenarioObjective)} onChange={value => set(scenarioObjective, value)} />
          <Button disabled={!!read(draftError)} onPress={() => mutateGraph(graph => ({ ...graph, name: read(scenarioName), objective: read(scenarioObjective) }))}>Применить название и цель</Button>
        </Stack>
      </Card>
      <RadioGroup label="Вид редактора" orientation="horizontal" value={read(viewMode)} options={[{ value: 'map', label: 'Карта' }, { value: 'yaml', label: 'YAML' }, { value: 'split', label: 'Рядом' }]} onChange={value => set(viewMode, value)} />
      <Grid minItemWidth="lg" gap="md">
        {read(viewMode) !== 'yaml' ? <Box maxHeight={360} scroll="y"><GraphEditor /></Box> : null}
        {read(viewMode) !== 'map' ? <Box maxHeight={360} scroll="y"><Textarea label="YAML-сценарий" rows={12} value={read(draft)} onChange={syncDraft} /></Box> : null}
      </Grid>
      {read(viewMode) !== 'yaml' ? <StepEditor /> : null}
      <Collapsible title="Составить сценарий агентом">
        <Stack gap="sm">
          <Textarea label="Цель" rows={3} value={read(objective)} placeholder="Что нужно сделать и как проверить результат?" onChange={(value) => set(objective, value)} />
          <Row gap="sm" align="end" wrap>
            <Select
              label="Planner"
              value={read(plannerAgent)}
              options={agentOptions(read(data)?.agents, [read(plannerAgent)])}
              onChange={(value) => set(plannerAgent, value)}
            />
            <Button variant="outline" icon="agent" disabled={disabled || read(plan)?.status === 'running'} onPress={generatePlan}>Составить YAML</Button>
            {read(plan)?.status === 'running' ? <Badge tone="accent">Planner работает…</Badge> : null}
            {read(plan)?.status === 'done' ? <Badge tone="success">YAML обновлён</Badge> : null}
          </Row>
          {read(plan)?.error ? <Callout tone="danger" title="Planner"><Text>{read(plan)?.error}</Text></Callout> : null}
        </Stack>
      </Collapsible>
      <Callout title="Проверка результата" icon="info">
        <Text size="sm">Каждый шаг обязан выполнить acceptance-команды и отправить worker_done. Перед failover старый Dispatch останавливается и получает новый continuation checkpoint.</Text>
      </Callout>
    </Stack>
  )
}

function AttemptsView({ run }: { run: PipelineRun }) {
  const id = read(stepId)
  const task = run.tasks[id]
  const step = run.scenario.steps.find((candidate) => candidate.id === id)
  if (!task || !step) return null
  const last = task.attempts.at(-1)
  return (
    <Card title={step.title} description={step.spec}>
      <Stack gap="sm">
        <KeyValue items={[
          { label: 'Task', value: task.taskId },
          { label: 'Bead', value: task.beadId ?? '—' },
          { label: 'Agent', value: task.agent },
          { label: 'Host', value: step.placement.host },
          { label: 'Workspace', value: step.placement.worktree },
          { label: 'Fallback', value: step.fallback.join(' → ') || '—' }
        ]} />
        {task.error ? <Callout tone="danger" title="Ошибка"><Text>{task.error}</Text></Callout> : null}
        {task.gateId && task.status === 'blocked' ? (
          <Callout tone="warning" title="Нужно решение">
            <Stack gap="sm">
              <Text size="sm">{step.approval}</Text>
              <Row gap="sm">
                {(['approve', 'reject'] as const).map((resolution) => (
                  <Button
                    size="sm"
                    tone={resolution === 'reject' ? 'danger' : 'success'}
                    variant="outline"
                    disabled={read(busy)}
                    onPress={() => action(async () => {
                      const answer = await plugin.request('run.resolve-gate', { id: run.id, stepId: step.id, resolution })
                      update(data, (previous) => previous ? { ...previous, runs: previous.runs.map((item) => item.id === run.id ? answer.run : item) } : previous)
                    })}
                  >{resolution === 'approve' ? 'Разрешить' : 'Отклонить'}</Button>
                ))}
              </Row>
            </Stack>
          </Callout>
        ) : null}
        {last?.status === 'running' && step.fallback.length ? (
          <Button
            size="sm"
            variant="outline"
            icon="agent"
            disabled={read(busy)}
            onPress={() => action(async () => {
              const answer = await plugin.request('run.switch-agent', { id: run.id, stepId: step.id })
              update(data, (previous) => previous ? { ...previous, runs: previous.runs.map((item) => item.id === run.id ? answer.run : item) } : previous)
            })}
          >Остановить и сменить агента</Button>
        ) : null}
        <Collapsible title={`Попытки: ${task.attempts.length}`} defaultOpen={task.attempts.length > 1}>
          <List>
            {task.attempts.map((attempt, index) => (
              <ListItem
                title={`${index + 1}. ${attempt.agent} · ${attempt.status}`}
                description={`${attempt.startedAt}${attempt.reason ? ` · ${attempt.reason}` : ''}${attempt.artifactPath ? ` · ${attempt.artifactPath}` : ''}`}
              />
            ))}
          </List>
        </Collapsible>
        {last?.output ? <Collapsible title="Последний вывод"><CodeView code={last.output} maxHeight="md" wrap /></Collapsible> : null}
        <Collapsible title="Acceptance">
          <List>{step.acceptance.map((command) => <ListItem title={command} icon="check" />)}</List>
        </Collapsible>
      </Stack>
    </Card>
  )
}

function RunsView() {
  const dashboard = read(data)
  if (!dashboard?.runs.length) return <EmptyState icon="activity" title="Запусков пока нет" description="Проверьте YAML и запустите первый pipeline на вкладке «Сценарий»." />
  const run = selectedRun()!
  const tasks = run.scenario.steps.map((step) => run.tasks[step.id]).filter(Boolean)
  const completed = tasks.filter((task) => task.status === 'done' || task.status === 'superseded').length
  return (
    <Stack gap="md">
      <Select
        label="Запуск"
        value={run.id}
        options={dashboard.runs.map((item) => ({ value: item.id, label: `${item.scenario.name} · ${item.status}` }))}
        onChange={(value) => {
          set(runId, value)
          set(stepId, '')
        }}
      />
      <Row justify="between" align="center">
        <Stack gap="xs">
          <Heading level={2}>{run.scenario.name}</Heading>
          <Text muted size="xs">{run.runId}</Text>
        </Stack>
        <Badge tone={run.status === 'done' ? 'success' : run.status === 'failed' ? 'danger' : 'accent'}>{run.status}</Badge>
      </Row>
      <Progress label={`${completed} из ${tasks.length}`} value={tasks.length ? completed / tasks.length : 0} />
      {run.pr ? <Callout tone={run.pr.status === 'failed' ? 'danger' : run.pr.status === 'merged' ? 'success' : 'accent'} title={`PR: ${run.pr.status}`}><Text size="sm">{run.pr.url}</Text></Callout> : null}
      <Row gap="xs" wrap>
        {run.status === 'running' ? <Button size="sm" variant="outline" icon="pause" onPress={() => runCommand('pause', run.id)}>Пауза</Button> : null}
        {run.status === 'paused' ? <Button size="sm" icon="play" onPress={() => runCommand('resume', run.id)}>Продолжить</Button> : null}
        {run.status === 'failed' ? <Button size="sm" icon="next" onPress={() => runCommand('retry', run.id)}>Следующий fallback</Button> : null}
        <Button size="sm" variant="ghost" icon="refresh" onPress={() => runCommand('tick', run.id)}>Обновить</Button>
        {run.status === 'running' || run.status === 'paused' ? <Button size="sm" variant="ghost" tone="danger" icon="stop" onPress={() => runCommand('cancel', run.id)}>Остановить</Button> : null}
      </Row>
      {run.error ? <Callout tone="danger" title="Coordinator"><Text>{run.error}</Text></Callout> : null}
      <Separator />
      <List label="DAG и статусы шагов">
        {run.scenario.steps.map((step) => {
          const task = run.tasks[step.id]
          if (!task) return null
          return (
            <ListItem
              current={read(stepId) === step.id}
              title={`${step.title}  ·  ${task.agent}`}
              description={`${STATUS[task.status].label}${step.needs.length ? ` · после ${step.needs.join(', ')}` : ''} · попыток ${task.attempts.length}`}
              icon={task.status === 'done' ? 'check' : task.status === 'failed' ? 'error' : 'agent'}
              onPress={() => set(stepId, step.id)}
            />
          )
        })}
      </List>
      <AttemptsView run={run} />
    </Stack>
  )
}

function MetricsView() {
  const dashboard = read(data)
  if (!dashboard) return <EmptyState icon="bar-chart-3" title="Нет метрик" description="Запустите pipeline, чтобы увидеть статистику" />
  const metrics = dashboard.metrics
  const minutes = Math.round(metrics.durationMs / 60_000)
  return (
    <Stack gap="md">
      <Heading level={2}>Метрики</Heading>
      <KeyValue items={[
        { label: 'Длительность', value: `${minutes} мин` },
        { label: 'Попытки', value: metrics.attempts },
        { label: 'Failovers', value: metrics.failovers },
        { label: 'Шаги', value: `${metrics.completedSteps}/${metrics.totalSteps}` },
        { label: 'Успех', value: `${metrics.successRate}%` }
      ]} />
      <Table
        label="По агентам"
        columns={[
          { key: 'agent', label: 'Агент' },
          { key: 'attempts', label: 'Попытки', width: 'sm' },
          { key: 'succeeded', label: 'Успех', width: 'sm' },
          { key: 'failed', label: 'Ошибки', width: 'sm' }
        ]}
        rows={metrics.byAgent.map((row) => ({ key: row.agent, cells: row }))}
        emptyText="Попыток пока нет"
      />
      <Collapsible title="Timeline по Runs">
        <List>
          {dashboard.runs.map((run) => (
            <ListItem
              title={`${run.scenario.name} · ${run.status}`}
              description={`${run.createdAt} → ${run.updatedAt} · ${Object.values(run.tasks).reduce((sum, task) => sum + task.attempts.length, 0)} попыток`}
              icon="activity"
            />
          ))}
        </List>
      </Collapsible>
    </Stack>
  )
}

function BeadsView() {
  const dashboard = read(data)
  const all = dashboard?.beads ?? []
  const query = read(beadSearch).trim().toLowerCase()
  const epic = read(beadEpic)
  const status = read(beadStatus)
  const beads = all.filter((bead) => {
    if (query && !`${bead.title} ${bead.id}`.toLowerCase().includes(query)) return false
    if (status !== 'all' && bead.status !== status) return false
    if (epic !== 'all' && bead.parentId !== epic && bead.id !== epic) return false
    return true
  })
  const epics = all.filter((bead) => bead.issueType === 'epic')
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Beads</Heading>
        <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>Обновить</Button>
      </Row>
      <Input label="Поиск по задачам" type="search" value={read(beadSearch)} placeholder="Название или ID" onChange={(value) => set(beadSearch, value)} />
      <Row gap="sm" wrap>
        <Select
          label="Статус"
          value={status}
          options={['all', 'open', 'in_progress', 'blocked', 'closed'].map((value) => ({ value, label: value === 'all' ? 'Все' : value }))}
          onChange={(value) => set(beadStatus, value)}
        />
        <Select
          label="Epic"
          value={epic}
          options={[{ value: 'all', label: 'Все epics' }, ...epics.map((item) => ({ value: item.id, label: item.title }))]}
          onChange={(value) => set(beadEpic, value)}
        />
      </Row>
      {epics.length ? (
        <List label="Epic progress">
          {epics.map((item) => {
            const children = all.filter((bead) => bead.parentId === item.id)
            const closed = children.filter((bead) => bead.status === 'closed').length
            return <ListItem title={item.title} description={`${closed}/${children.length} закрыто`} icon="layers" />
          })}
        </List>
      ) : null}
      {dashboard?.beadsError ? (
        <Callout tone="warning" title="bd недоступен">
          <Text size="sm">{dashboard.beadsError}. Укажите путь к bd в Settings → Plugins → Agent Pipeline.</Text>
        </Callout>
      ) : null}
      <Text muted size="xs">По строке: claim или close; по закрытой — reopen.</Text>
      <Table
        label="Задачи Beads"
        columns={[
          { key: 'status', label: 'Статус', width: 'sm' },
          { key: 'title', label: 'Задача' },
          { key: 'type', label: 'Тип', width: 'xs', hideBelow: 'sm' },
          { key: 'priority', label: 'P', width: 'xs', hideBelow: 'sm' }
        ]}
        rows={beads.map((bead) => ({
          key: bead.id,
          cells: { status: bead.status, title: `${bead.title} · ${bead.id}`, type: bead.issueType ?? 'task', priority: bead.priority ?? '—' }
        }))}
        emptyText="Задачи не найдены"
        maxHeight="lg"
        onRowAction={({ key }) => {
          const bead = all.find((candidate) => candidate.id === key)
          if (bead) void changeBead(key, bead.status === 'closed' ? 'reopen' : bead.status === 'open' ? 'claim' : 'close')
        }}
      />
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  syncDraft(read(draft))
  ctx.subscriptions.push(plugin.on('run.changed', ({ run }) => {
    update(data, (previous) => previous ? {
      ...previous,
      runs: [run, ...previous.runs.filter((item) => item.id !== run.id)]
    } : previous)
  }))
  ctx.subscriptions.push(plugin.on('plan.changed', ({ plan: updated }) => {
    receivePlan(updated)
  }))
  void refresh()
}

export default function Panel() {
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Agent Pipeline</Heading>
        {read(busy) ? <Badge tone="accent">Работаю…</Badge> : null}
      </Row>
      {read(error) ? <Callout tone="danger" title="Ошибка"><Text>{read(error)}</Text></Callout> : null}
      <Tabs label="Agent Pipeline" value={read(tab)} onChange={(value) => set(tab, value)}>
        <Tab value="scenario" label="Сценарий" icon="file-text"><ScenarioView /></Tab>
        <Tab value="runs" label="Выполнение" icon="activity"><RunsView /></Tab>
        <Tab value="metrics" label="Метрики" icon="bar-chart-3"><MetricsView /></Tab>
        <Tab value="beads" label="Beads" icon="book"><BeadsView /></Tab>
      </Tabs>
      {read(busy) ? null : null}
    </Stack>
  )
}
