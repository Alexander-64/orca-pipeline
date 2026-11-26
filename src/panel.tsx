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
  Link,
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
  settings,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { diagnosticText, renderDiagnostic } from './diagnostics'
import { languageOf, translate, type Language, type Message } from './i18n'
import { countRunSteps, STATUS } from './step-status'
import { Comparison, Rehearsal, TemplateLibrary, WorktreeReview, resetRehearsal } from './workflow-views'
import { RunResult } from './result-view'
import { HistoryBrowser } from './history-view'
import { metricsForRuns } from './metrics'
import { agentOptions } from './agents'
import { parseScenario, serializeScenario, workspaceRestrictionConflicts } from './scenario'
import { waves, validateGraph, patchStep, insertStep, deleteStep } from './editor'
import { defaultScenario, scenarioTemplate } from './templates'
import { type Dashboard, type Workspace, type PipelineRun, type PlannerRun, type Scenario, type StepStatus, type RecoveryReport } from './types'
import { appendCondition, conditionLabel, conditionValue, filterCondition, parseCondition, parseOutputSchema, predecessorFields, predicates } from '../packages/core/results'
import type { Predicate } from './types'

const language = atom<Language>('en')
const t = (key: Message, ...values: unknown[]) => translate(read(language), key, ...values)

const diagnosis = (raw?: string | null) => diagnosticText(read(language), raw)

const tab = atom('pipeline.tab', 'scenario', { persist: 'plugin' })
const launchExpanded = atom<boolean | null>(null)
const projectDrafts = atom<Record<string, string>>('pipeline.project-drafts', {}, { persist: 'plugin' })
const stage = atom('pipeline.stage', 'project', { persist: 'plugin' })
const UNINITIALIZED_DRAFT = '\u0000pipeline:new-draft'
const draft = atom<string>('pipeline.draft', UNINITIALIZED_DRAFT, { persist: 'plugin' })
const workspaceId = atom('pipeline.workspace', '', { persist: 'plugin' })
const runMode = atom<'new' | 'existing' | null>('pipeline.run-mode', null, { persist: 'plugin' })
const runId = atom('pipeline.run', '', { persist: 'plugin' })
const stepId = atom('pipeline.step', '', { persist: 'plugin' })
const objective = atom('pipeline.objective', '', { persist: 'plugin' })
const plannerModel = atom('pipeline.planner-model', '', { persist: 'plugin' })
const plannerEffort = atom('pipeline.planner-effort', '', { persist: 'plugin' })
const plannerAgent = atom('pipeline.planner-agent', 'codex', { persist: 'plugin' })
const separateWorkspace = atom('pipeline.separate-workspace', true, { persist: 'plugin' })
const viewMode = atom('pipeline.editor-view', 'split', { persist: 'plugin' })
const appliedPlans = atom<string[]>('pipeline.applied-plans', [], { persist: 'plugin' })
const scenarioName = atom('')
const scenarioObjective = atom('')
const plan = atom<PlannerRun | null>(null)
const runScenario = atom<Scenario | null>(null)
const fileName = atom('')
const fileNames = atom<string[] | null>(null)
const openedFile = atom<{ workspaceId: string; name: string; source: string } | null>(null)
const fileStatus = atom('')
const validated = atom<Scenario | null>(null)
const editorSelection = atom('')
const inspector = atom<Scenario['steps'][number] | null>(null)
const schemaDraft = atom('')
const conditionSource = atom('')
const conditionOp = atom<Predicate['op']>('eq')
const conditionText = atom('')
const conditionGroup = atom<'all' | 'any'>('all')
const draftError = atom<string | null>(null)
const editError = atom<string | null>(null)
const template = atom('pipeline.template', 'custom', { persist: 'plugin' })
const taskSearch = atom('')
const taskStatus = atom('all')
const beadSearch = atom('pipeline.bead-search', '', { persist: 'plugin' })
const beadStatus = atom('pipeline.bead-status', 'all', { persist: 'plugin' })
const beadEpic = atom('pipeline.bead-epic', 'all', { persist: 'plugin' })
const data = atom<Dashboard | null>(null)
const busy = atom(false)
const error = atom<string | null>(null)
const recoveryReport = atom<RecoveryReport | null>(null)
const repairing = atom(false)
const messageDrafts = atom<Record<string, { id: string; text: string }>>({})



function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function selectNode(id: string): void {
  set(editorSelection, id)
  set(inspector, read(validated)?.steps.find(step => step.id === id) ?? null)
  set(schemaDraft, read(inspector)?.outputSchema ? JSON.stringify(read(inspector)!.outputSchema, null, 2) : '')
  set(conditionSource, ''); set(conditionOp, 'eq'); set(conditionText, ''); set(conditionGroup, 'all')
  set(editError, null)
}

function syncDraft(source: string): void {
  if (source !== read(draft)) resetRehearsal()
  set(draft, source)
  set(fileStatus, '')
  if (read(workspaceId)) update(projectDrafts, drafts => ({ ...drafts, [read(workspaceId)]: source }))
  try {
    set(runScenario, parseScenario(source))
    const scenario = parseScenario(source, { expandEvidence: false })
    set(validated, scenario)
    set(scenarioName, scenario.name)
    set(scenarioObjective, scenario.objective)
    set(draftError, null)
    selectNode(scenario.steps.some(step => step.id === read(editorSelection)) ? read(editorSelection) : scenario.steps[0].id)
  } catch (value) {
    set(runScenario, null)
    set(draftError, message(value))
  }
}

function mutateGraph(operation: (scenario: Scenario) => Scenario, selectLast = false): void {
  const scenario = read(validated)
  if (viewingRun() || !scenario || read(draftError)) return
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
  if (viewingRun()) return
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
  if (!viewingRun() && current?.id === next.id && current.status === 'running' && next.status === 'done') { set(stage, 'steps'); set(viewMode, 'map') }
}

function PlannerSummary() {
  const current = read(plan)
  if (!current) return null
  let summary: Scenario | null = null
  try { if (current.source) summary = parseScenario(current.source, { expandEvidence: false }) } catch {}
  return <Collapsible title={`Planner · ${current.agent} · ${current.status}`}>
    <Stack gap="xs">
      {current.outputPath ? <Button variant="outline" onPress={() => action(async () => { await plugin.request('plan.open', { id: current.id }) })}>{t("Open YAML tab")}</Button> : null}
      <Badge tone={current.status === 'failed' ? 'danger' : current.status === 'done' ? 'success' : 'accent'}>{current.status}</Badge>
      <KeyValue items={[
        { label: t("Planner objective"), value: current.objective ?? read(objective) },
        { label: t("Planner agent"), value: current.agent },
        { label: 'Run ID', value: current.runId }
      ]} />
      {current.error ? <Callout title="Planner error" tone="danger"><Text>{diagnosis(current.error)}</Text></Callout> : null}
      {summary ? <KeyValue items={[
        { label: 'Scenario name', value: summary.name },
        { label: 'Scenario objective', value: summary.objective },
        { label: t("Steps"), value: summary.steps.length },
        { label: t("Waves"), value: waves(summary.steps).length }
      ]} /> : null}
    </Stack>
  </Collapsible>
}

let dashboardRevision = 0
async function refresh(selected?: string): Promise<void> {
  const id = selected ?? read(workspaceId)
  const revision = ++dashboardRevision
  const current = () => revision === dashboardRevision && id === read(workspaceId)
  try {
    const answer = await plugin.request('dashboard.get', { ...(id ? { workspaceId: id } : {}), ...(read(runId) && read(runMode) !== 'new' ? { selectedRunId: read(runId) } : {}) })
    if (!current()) return
    set(data, answer)
    if (!id && answer.workspaces[0]) set(workspaceId, answer.workspaces[0].id)
    set(error, null)
    const latest = answer.plans?.at(-1)
    if (latest) receivePlan(latest)
  } catch (value) {
    if (current()) set(error, message(value))
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
  if (viewingRun()) return
  await action(async () => {
    const id = read(workspaceId)
    if (!id) throw new Error(t("Choose a workspace"))
    const answer = await plugin.request('plan.start', {
      workspaceId: id,
      objective: read(objective),
      agent: read(plannerAgent),
      ...(read(plannerModel) ? { model: read(plannerModel) } : {}),
      ...(read(plannerEffort) ? { effort: read(plannerEffort) } : {})
    })
    receivePlan(answer.plan)
  })
}

function supportsSeparateWorkspace(workspace?: Workspace): boolean {
  return workspace?.kind === 'worktree' && (!workspace.hostId || workspace.hostId === 'local')
}

async function start(): Promise<void> {
  if (viewingRun()) return
  await action(async () => {
    const id = read(workspaceId)
    if (!id) throw new Error(t("Choose a workspace"))
    const workspace = read(data)?.workspaces.find(item => item.id === id)
    const { run } = await plugin.request('run.start', { workspaceId: id, source: read(draft), separateWorkspace: supportsSeparateWorkspace(workspace) && read(separateWorkspace) }, { timeoutMs: 120_000 })
    set(runId, run.id)
    set(runMode, 'existing')
    set(stepId, '')
    set(tab, 'scenario')
    set(stage, 'monitor')
    set(launchExpanded, false)
    update(data, previous => mergeRun(previous, run))
  })
}

function needsRecovery(run: PipelineRun): boolean {
  const dashboard = read(data)
  return !!dashboard?.recoveryWarning && (!dashboard.recoveryRunIds || dashboard.recoveryRunIds.includes(run.id)) || Object.values(run.tasks).some(task => task.unconfirmedStart || task.unconfirmedChecks)
}

function recoveryExplanation(run?: PipelineRun): string {
  const disabled = run && Object.values(run.tasks).map(task => /Agent ([\w.-]+) is disabled/i.exec(task.error ?? '')?.[1]).find(Boolean)
  return disabled
    ? t("Agent {0} is disabled. Recovery will check whether it received the task and select an available fallback. Completed results are saved.", disabled)
    : t("The last agent launch is unconfirmed. Recovery will check existing sessions before retrying. Completed results are saved.")
}

async function runCommand(kind: 'pause' | 'resume' | 'retry' | 'cancel' | 'tick', id: string): Promise<void> {
  const run = selectedRun()
  if ((kind === 'resume' || kind === 'retry') && run && needsRecovery(run)) { await repairRun(); return }
  await action(async () => {
    const request = kind === 'pause' ? 'run.pause' : kind === 'resume' ? 'run.resume' : kind === 'retry' ? 'run.retry' : kind === 'cancel' ? 'run.cancel' : 'run.tick'
    const { run } = await plugin.request(request, { id })
    update(data, previous => mergeRun(previous, run))
  })
}

async function changeBead(id: string, beadAction: 'claim' | 'close' | 'reopen'): Promise<void> {
  await action(async () => {
    const selected = read(workspaceId)
    const revision = ++dashboardRevision
    const current = () => selected === read(workspaceId) && revision === dashboardRevision
    try {
      const answer = await plugin.request('beads.action', { workspaceId: selected, id, action: beadAction })
      if (current()) set(data, answer)
    } catch (cause) { if (current()) throw cause }
  })
}

function statusBadge(status: StepStatus) {
  const item = STATUS[status]
  return <Badge tone={item.tone}>{t(item.label)}</Badge>
}

function selectedRun(): PipelineRun | undefined {
  const dashboard = read(data)
  const history = dashboard?.runHistory ?? dashboard?.runs ?? []
  return history.find(run => run.id === read(runId)) ?? dashboard?.runs[0] ?? history[0]
}

function mergeRun(previous: Dashboard | null, run: PipelineRun): Dashboard | null {
  if (!previous) return previous
  const belongs = run.workspaceId === read(workspaceId) || run.sourceWorkspaceId === read(workspaceId)
  return { ...previous,
    runs: belongs ? [run, ...previous.runs.filter(item => item.id !== run.id)] : previous.runs.map(item => item.id === run.id ? run : item),
    runHistory: [run, ...(previous.runHistory ?? previous.runs).filter(item => item.id !== run.id)]
  }
}

function viewingRun(): boolean {
  return read(runMode) !== 'new' && !!selectedRun()
}

function newRun(): void {
  set(runMode, 'new')
  set(stepId, '')
  set(stage, 'project')
  set(tab, 'scenario')
  set(launchExpanded, true)
  set(error, null)
}

async function repairRun(): Promise<void> {
  const run = selectedRun()
  if (!run || read(repairing)) return
  set(runId, run.id)
  set(repairing, true)
  set(recoveryReport, { runId: run.id, status: 'checking', messages: [t("Checking why the run stopped…")], updatedAt: new Date().toISOString() })
  try {
    await action(async () => {
      const revision = dashboardRevision
      const result = await plugin.request('run.repair', { id: run.id }, { timeoutMs: 120_000 })
      if (revision === dashboardRevision && run.id === read(runId) && (run.sourceWorkspaceId ?? run.workspaceId) === read(workspaceId)) {
        dashboardRevision++
        set(data, result.dashboard)
      } else await refresh()
      set(recoveryReport, result.report)
    })
  } finally { set(repairing, false) }
}

function RepairButton() {
  const run = viewingRun() ? selectedRun() : undefined
  if (!run) return null
  const checking = read(repairing) || read(recoveryReport)?.runId === run.id && read(recoveryReport)?.status === 'checking'
  return <Button icon="refresh" disabled={read(busy) || checking || ['done', 'cancelled'].includes(run.status)} onPress={repairRun}>{checking ? t("Checking…") : t("Diagnose and continue")}</Button>
}

function runProject(run: PipelineRun): string {
  return read(data)?.workspaces.find(workspace => workspace.id === (run.sourceWorkspaceId ?? run.workspaceId))?.name ?? run.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? run.workspaceId
}

function RunPicker() {
  const runs = read(data)?.runHistory ?? read(data)?.runs ?? []
  const run = viewingRun() ? selectedRun() : undefined
  return <Stack gap="xs"><Box direction="row" align="end" gap="sm" wrap padding="sm" border radius="md" background="muted">
    <Box grow width={320} minWidth={0} maxWidth="100%">
      <Select label={t("Run")} value={run?.id ?? 'new'} options={[
        { value: 'new', label: t("New run · setup") },
        ...runs.map(item => ({ value: item.id, label: `${runProject(item)} · ${item.scenario.name} · ${{ running: t("Running"), paused: t("Paused"), done: t("Completed"), failed: t("Error"), cancelled: t("Cancelled") }[item.status]} · ${item.createdAt.slice(0, 16).replace('T', ' ')} · ${item.id.slice(-6)}` }))
      ]} onChange={value => {
        if (value === 'new') { newRun(); return }
        set(runId, value); set(runMode, 'existing'); set(stepId, ''); set(error, null)
        if (read(tab) === 'scenario') set(stage, 'monitor')
      }} />
    </Box>
    <Box key="repair-action" width={205} maxWidth="100%" align="stretch"><RepairButton /></Box>
    <Button variant="outline" onPress={newRun}>{t("New run")}</Button>
    <Badge tone={run ? 'neutral' : 'accent'}>{run ? t("Parameters locked") : t("New run setup")}</Badge>
  </Box>
    <HistoryBrowser language={read(language)} workspaces={read(data)?.workspaces ?? []} open={item => {
      update(data, previous => mergeRun(previous, item))
      set(runId, item.id); set(runMode, 'existing'); set(stepId, ''); set(tab, 'result')
      void refresh()
    }} />
    {run ? <Text muted size="xs">{t("Project: {0} · Working folder: {1}", runProject(run), run.workspacePath)}</Text> : null}
  </Stack>
}

function RecoveryPanel() {
  const run = viewingRun() ? selectedRun() : undefined
  const warning = !run || needsRecovery(run) ? read(data)?.recoveryWarning : undefined
  const unresolved = !!warning || !!run && needsRecovery(run)
  const report = run && read(recoveryReport)?.runId === run.id ? read(recoveryReport) : null
  if (!unresolved && !report && (!run || ['running', 'done', 'cancelled'].includes(run.status))) return null
  const checking = report?.status === 'checking'
  const title = checking ? t("Diagnosing and recovering")
    : report?.status === 'blocked' ? t("Diagnosis")
      : report ? t("Recovery finished")
        : unresolved ? t("Agent recovery required")
          : run?.status === 'done' ? t("Run completed") : run?.status === 'paused' ? t("Run paused") : run?.status === 'failed' ? t("Run stopped") : t("Run status")
  return <Box key="recovery-status" height={144} shrink={false} scroll="y" gap="sm" padding="sm" border={unresolved || report?.status === 'blocked' ? 'warning' : checking ? 'accent' : true} radius="md">
    <Text weight="semibold">{title}</Text>
    <Text size="sm">{(report?.messages.length ? diagnosis(report.messages.at(-1)) : null) ?? (unresolved ? recoveryExplanation(run) : t("Recovery checks agent sessions and resumes work when possible. Completed step results are saved."))}</Text>
    {unresolved && !report ? <Text size="sm">{run ? t("Select “Diagnose and continue” above.") : t("Select the stopped run above, then choose “Diagnose and continue”.")}</Text> : null}
    {warning || report ? <Collapsible key={run?.id ?? 'new'} title={t("Diagnostic details")}>
      <Stack gap="sm">
        {report ? <List>{report.messages.map(text => <ListItem title={diagnosis(text)} />)}</List> : null}
        {warning ? <Text muted size="xs">{warning}</Text> : null}
      </Stack>
    </Collapsible> : null}
  </Box>
}

function StoredParameters({ run, steps = false }: { run: PipelineRun; steps?: boolean }) {
  return <Stack gap="md">
    <Callout title={t("Run parameters are locked")}><Text>{t("These are the settings used for this run. To change them and run again, select “New run” above.")}</Text></Callout>
    {steps ? <Stack gap="sm">
      {waves(run.scenario.steps).map((layer, index) => <Stack gap="sm">
        <Heading level={3}>{t("Wave {0}", index + 1)}</Heading>
        {layer.map(step => <Card title={step.title}>
          <Stack gap="sm">
            <Text muted size="sm">{`${step.agent}${step.fallback.length ? ` → ${step.fallback.join(' → ')}` : ''}`}</Text>
            <Text size="sm">{step.needs.length ? t("After: {0}", step.needs.map(id => run.scenario.steps.find(item => item.id === id)?.title ?? id).join(', ')) : t("Independent start")}</Text>
            {step.model ? <Text size="sm">{t("Model: {0}{1}", step.model, step.effort ? t(" · effort: {0}", step.effort) : '')}</Text> : null}
            <Collapsible title={t("Instructions · {0}", step.title)}><Text size="sm">{step.spec}</Text></Collapsible>
            <Text size="sm">{t("Checks: {0}", step.acceptance.join('; '))}</Text>
          </Stack>
        </Card>)}
      </Stack>)}
      <Collapsible title={t("Saved run YAML")}><CodeView code={serializeScenario(run.scenario)} language="yaml" wrap /></Collapsible>
    </Stack> : <KeyValue items={[
      { label: t("Scenario"), value: run.scenario.name }, { label: t("Objective"), value: run.scenario.objective },
      { label: t("Working folder"), value: run.workspacePath }, { label: t("Created"), value: run.createdAt },
      { label: t("Steps"), value: run.scenario.steps.length }, { label: t("Run ID"), value: run.runId }
    ]} />}
  </Stack>
}

function StepEditor() {
  const step = read(inspector)
  const scenario = read(validated)
  if (!step || !scenario) return null
  const locked = !!read(draftError)
  return <Card title={`Inspector · ${step.id}`}>
    <Stack gap="sm">
      <Input label={t("Step title")} value={step.title} onChange={title => updateInspector({ title })} />
      <Textarea label={t("Step instructions")} rows={8} value={step.spec} onChange={spec => updateInspector({ spec })} />
      <Select label={`Agent ${step.id}`} value={step.agent}
        options={agentOptions(read(data)?.agents, [step.agent])}
        onChange={agent => updateInspector({ agent, model: undefined, effort: undefined, fallback: step.fallback.filter(value => value !== agent), reviewAgent: step.reviewAgent === agent ? undefined : step.reviewAgent })} />
      <ModelChoice agent={step.agent} scope={t("Primary agent")} model={step.model} effort={step.effort} onChange={preferences => updateInspector(preferences)} />
      <AgentRouting step={step} />
      <Textarea label={t("Acceptance checks · one command per line")} rows={3} value={step.acceptance.join('\n')} onChange={value => updateInspector({ acceptance: value.split('\n').filter(item => item.trim()) })} />
      <StepDependencies step={step} scenario={scenario} />
      <ConditionControls step={step} scenario={scenario} />
      <Collapsible title={t("Structured result fields")}>
        <Textarea label={t("Result schema (JSON)")} rows={6} value={read(schemaDraft)} placeholder={'{"decision":{"type":"string","enum":["improve","pass"]}}'} onChange={value => set(schemaDraft, value)} />
        <Text muted size="xs">{t("Supported types are string, number and boolean. Fields are required unless marked required:false. Leave blank to disable structured results.")}</Text>
      </Collapsible>
      <Text muted size="xs">{t("Select Apply step to save. Cycles and invalid settings are rejected.")}</Text>
      <Row gap="xs" wrap>
        <Button disabled={locked} onPress={() => {
          try {
            const outputSchema = read(schemaDraft).trim() ? parseOutputSchema(JSON.parse(read(schemaDraft))) : undefined
            mutateGraph(graph => patchStep(graph, step.id, { ...step, outputSchema }))
          } catch (error) { set(editError, message(error)) }
        }}>{t("Apply step")}</Button>
        <Button variant="ghost" onPress={() => selectNode(step.id)}>{t("Reset fields")}</Button>
        <Button variant="ghost" tone="danger" disabled={locked || scenario.steps.length === 1} onPress={() => mutateGraph(graph => deleteStep(graph, step.id))}>{t("Delete")} {step.id}</Button>
      </Row>
    </Stack>
  </Card>
}

function ModelChoice({ agent, scope, model, effort, onChange }: {
  agent: string; scope: string; model?: string; effort?: string;
  onChange: (preferences: { model?: string; effort?: string }) => void
}) {
  const dashboard = read(data)
  const unsupported = dashboard?.modelCatalogState === 'unsupported' || dashboard?.unsupportedModelAgents?.includes(agent)
  const catalog = dashboard?.modelCatalogs?.[agent]
  const models = catalog?.models ?? []
  const selected = models.find(item => item.id === model)
  const missing = !!model && !selected
  return <Box gap="xs" padding="sm" radius="md" background="muted">
    <Text size="sm" weight="medium">{t("{0} · model and effort", scope)}</Text>
    <Select label={t("Model · {0}", scope)} value={model || '__agent_default__'} options={[
      { value: '__agent_default__', label: t("Agent default") },
      ...models.map(item => ({ value: item.id, label: item.label })),
      ...(missing ? [{ value: model!, label: t("{0} · saved, unavailable in catalog", model) }] : [])
    ]} onChange={value => onChange({ model: value === '__agent_default__' ? undefined : value, effort: undefined })} />
    {selected?.efforts.length ? <Select label={t("Effort · {0}", scope)} value={effort || '__model_default__'} options={[
      { value: '__model_default__', label: t("Model default") }, ...selected.efforts,
      ...(effort && !selected.efforts.some(item => item.value === effort) ? [{ value: effort, label: t("{0} · saved, unavailable in catalog", effort) }] : [])
    ]} onChange={value => onChange({ model, effort: value === '__model_default__' ? undefined : value })} /> : <Text muted size="xs">{model ? t("The catalog has no confirmed effort choices for this model.") : t("Choose a model to see its supported effort levels.")}</Text>}
    {missing ? <Text tone="warning" size="xs">{t("Choose an available model or the agent default before starting.")}</Text> : null}
    <Text muted size="xs">{catalog ? t("Last confirmed Orca catalog · {0}", new Date(catalog.observedAt).toISOString().slice(0, 16).replace('T', ' ')) : unsupported ? renderDiagnostic(read(language), { id: 'catalog.unsupported', agent }) : t("Open the model picker for this agent in Orca, then refresh the panel to load its catalog.")}</Text>
  </Box>
}

function StepDependencies({ step, scenario }: { step: Scenario['steps'][number]; scenario: Scenario }) {
  const number = (id: string) => scenario.steps.findIndex(item => item.id === id) + 1
  const title = (id: string) => scenario.steps.find(item => item.id === id)?.title ?? id
  // A successor cannot become an input: that would make the step wait for itself.
  const successors = new Set([step.id])
  let size = 0
  while (size !== successors.size) {
    size = successors.size
    for (const item of scenario.steps) if (item.needs.some(id => successors.has(id))) successors.add(item.id)
  }
  const available = scenario.steps.filter(item => item.id !== step.id && !step.needs.includes(item.id))
  return <Box gap="sm" padding="md" radius="md" border background="muted">
    <Row gap="xs" wrap>
      <Text weight="semibold">{t("Before this step")}</Text>
      <Badge tone={step.needs.length ? 'accent' : 'neutral'}>{step.needs.length ? t("Dependencies: {0}", step.needs.length) : t("Independent start")}</Badge>
    </Row>
    {step.needs.length ? <Stack gap="xs">
      <Row gap="xs" wrap>
        {step.needs.map(id => <Badge>{`#${number(id)}`}</Badge>)}
        <Text muted>→</Text><Badge tone="accent">{t("#{0} · this step", number(step.id))}</Badge>
      </Row>
      {step.needs.map(id => <Box direction="row" gap="sm" align="center" padding="sm" radius="sm" background="card" wrap>
        <Badge>{`#${number(id)}`}</Badge>
        <Box grow minWidth={140}><Text>{title(id)}</Text></Box>
        <Button size="sm" variant="ghost" tooltip={t("Remove dependency: {0}", title(id))} onPress={() => updateInspector({ needs: step.needs.filter(value => value !== id) })}>{t("Remove #{0}", number(id))}</Button>
      </Box>)}
      <Select label={t("When to start this step")} value={step.join ?? 'all_success'} options={[
        { value: 'all_success', label: t("After all selected steps succeed") },
        { value: 'all_settled', label: t("After all selected steps finish, with any outcome") }
      ]} onChange={value => updateInspector({ join: value as 'all_success' | 'all_settled' })} />
      <Text muted size="xs">{step.join === 'all_settled' ? t("Failed or skipped predecessors allow this step to proceed. Output conditions are checked separately.") : t("All predecessors must succeed. A failure or skipped step blocks this step.")}</Text>
    </Stack> : <Text muted size="sm">{t("Can run alongside other steps without waiting for them.")}</Text>}
    {available.length ? <Stack gap="xs">
      <Text size="sm" weight="medium">{t("Add predecessor")}</Text>
      <Box direction="row" gap="xs" wrap>
        {available.map(item => <Box width={220} grow minWidth={160} gap="xs" padding="sm" radius="sm" border background="card">
          <Row gap="xs"><Badge>{`#${number(item.id)}`}</Badge><Text muted size="xs">{item.agent}</Text></Row>
          <Text size="sm">{item.title}</Text>
          {successors.has(item.id) ? <Text muted size="xs">{t("Follows this step · adding it would create a cycle")}</Text> : null}
          <Button size="sm" variant="outline" disabled={successors.has(item.id)} onPress={() => updateInspector({ needs: [...step.needs, item.id] })}>{t("Add #{0}", number(item.id))}</Button>
        </Box>)}
      </Box>
    </Stack> : scenario.steps.length === 1 ? <Text muted size="xs">{t("Add another step to configure dependencies.")}</Text> : null}
    <Separator />
    <Input label={t("Approval before starting")} value={step.approval ?? ''} placeholder={t("For example, ask the project lead to review the result")} onChange={approval => updateInspector({ approval: approval.trim() || undefined })} />
    <Text muted size="xs">{t("Optional. Enter a prompt to require approval before this step starts.")}</Text>
  </Box>
}

function AgentRouting({ step }: { step: Scenario['steps'][number] }) {
  const options = agentOptions(read(data)?.agents, [step.agent, ...step.fallback, step.reviewAgent ?? ''])
  const label = (id: string) => options.find(option => option.value === id)?.label ?? id
  const move = (index: number, offset: number) => {
    const fallback = [...step.fallback]
    const target = index + offset
    if (target < 0 || target >= fallback.length) return
    ;[fallback[index], fallback[target]] = [fallback[target], fallback[index]]
    updateInspector({ fallback })
  }
  return <Stack gap="sm">
    <Box gap="sm" padding="md" radius="md" border background="muted">
      <Text weight="semibold">{t("Agent order")}</Text>
      <Row gap="xs" wrap>
        <Badge tone="accent">{t("1 · {0} · primary", label(step.agent))}</Badge>
        {step.fallback.map((id, index) => <Row gap="xs">
          <Text muted>→</Text><Badge>{`${index + 2} · ${label(id)}`}</Badge>
        </Row>)}
      </Row>
      <Text muted size="xs">{t("On a confirmed quota limit or manual switch, the next agent in the list takes over.")}</Text>
      {step.fallback.length ? <Stack gap="xs">
        {step.fallback.map((id, index) => <Box direction="row" gap="xs" align="center" padding="sm" radius="sm" background="card" wrap>
          <Badge>{index + 2}</Badge>
          <Box grow><Text weight="medium">{label(id)}</Text></Box>
          <Button size="sm" variant="ghost" tooltip={t("Move up: {0}", label(id))} disabled={index === 0} onPress={() => move(index, -1)}>↑</Button>
          <Button size="sm" variant="ghost" tooltip={t("Move down: {0}", label(id))} disabled={index === step.fallback.length - 1} onPress={() => move(index, 1)}>↓</Button>
          <Button size="sm" variant="ghost" tooltip={t("Remove {0} from fallback agents", label(id))} onPress={() => updateInspector({ fallback: step.fallback.filter(value => value !== id) })}>{t("Remove {0}", label(id))}</Button>
        </Box>)}
      </Stack> : <Text muted size="sm">{t("No fallback agents yet")}</Text>}
      <Text size="sm" weight="medium">{t("Add fallback agent")}</Text>
      <Row gap="xs" wrap>
        {options.filter(option => option.value !== step.agent && !step.fallback.includes(option.value)).map(option => <Button size="sm" variant="outline" onPress={() => updateInspector({ fallback: [...step.fallback, option.value] })}>{`+ ${option.label}`}</Button>)}
      </Row>
    </Box>
    {step.fallback.map(agent => <Collapsible title={t("Fallback model · {0}", agent)}>
      <ModelChoice agent={agent} scope={t("Fallback {0}", agent)} model={step.agentPreferences?.[agent]?.model} effort={step.agentPreferences?.[agent]?.effort} onChange={preferences => updateInspector({ agentPreferences: { ...step.agentPreferences, [agent]: preferences } })} />
    </Collapsible>)}
    <Box gap="xs" padding="md" radius="md" border>
      <Select label={t("Review agent")} value={step.reviewAgent ?? 'none'}
        options={[{ value: 'none', label: t("No additional review") }, ...options.filter(option => option.value !== step.agent)]}
        onChange={value => updateInspector({ reviewAgent: value === 'none' ? undefined : value })} />
      <Text muted size="xs">{t("A separate agent checks the result before the pipeline continues.")}</Text>
      {step.reviewAgent ? <ModelChoice agent={step.reviewAgent} scope={t("Reviewer")} model={step.agentPreferences?.[step.reviewAgent]?.model} effort={step.agentPreferences?.[step.reviewAgent]?.effort} onChange={preferences => updateInspector({ agentPreferences: { ...step.agentPreferences, [step.reviewAgent!]: preferences } })} /> : null}
    </Box>
  </Stack>
}

function ConditionControls({ step, scenario }: { step: Scenario['steps'][number]; scenario: Scenario }) {
  const fields = predecessorFields(step, scenario.steps)
  const selected = fields.find(field => `${field.step}:${field.field}` === read(conditionSource)) ?? fields[0]
  const options = read(conditionOp) === 'exists' || selected?.type === 'boolean' ? [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]
    : selected?.enum?.map(value => ({ value: String(value), label: String(value) }))
  const value = read(conditionText) || options?.[0]?.value || ''
  return <Stack gap="sm">
    <Text size="sm">{t("Output conditions")}</Text>
    {step.when ? <Text>{conditionLabel(step.when, read(language))}</Text> : <Text muted>{t("No output condition")}</Text>}
    {step.when ? predicates(step.when).map((predicate, index) => <Row gap="xs" wrap>
      <Text size="sm">{conditionLabel(predicate, read(language))}</Text>
      <Button size="sm" variant="ghost" onPress={() => { let position = 0; updateInspector({ when: filterCondition(step.when, () => position++ !== index) }) }}>{t("Remove condition")} {index + 1}</Button>
    </Row>) : null}
    {!selected ? <Text muted size="xs">{t("Connect a predecessor that declares output fields.")}</Text> : <Stack gap="sm">
      <Select label={t("Predecessor field")} value={`${selected.step}:${selected.field}`} options={fields.map(field => ({ value: `${field.step}:${field.field}`, label: `${field.step}.${field.field} · ${field.type}` }))} onChange={value => { set(conditionSource, value); set(conditionOp, 'eq'); set(conditionText, '') }} />
      <Select label={t("Comparison")} value={read(conditionOp)} options={['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'].filter(op => selected.type === 'number' || !['gt', 'gte', 'lt', 'lte'].includes(op)).map(op => ({ value: op, label: op }))} onChange={value => { set(conditionOp, value as Predicate['op']); set(conditionText, '') }} />
      {options ? <Select label={t("Condition value")} value={value} options={options} onChange={value => set(conditionText, value)} /> : <Input label={t("Condition value")} value={read(conditionText)} onChange={value => set(conditionText, value)} />}
      <Select label={t("Combine with")} value={read(conditionGroup)} options={[{ value: 'all', label: t("AND · all checks") }, { value: 'any', label: t("OR · any check") }]} onChange={value => set(conditionGroup, value as 'all' | 'any')} />
      <Button size="sm" variant="outline" onPress={() => {
        try {
          const clause = parseCondition({ step: selected.step, field: selected.field, op: read(conditionOp), value: conditionValue(selected.type, read(conditionOp), value) })
          updateInspector({ when: appendCondition(step.when, clause, read(conditionGroup)) })
        } catch (error) { set(editError, message(error)) }
      }}>{t("Add check")}</Button>
    </Stack>}
  </Stack>
}

function GraphEditor() {
  const scenario = read(validated)
  if (!scenario) return null
  const layers = waves(scenario.steps)
  const locked = !!read(draftError)
  const selected = read(editorSelection)
  const number = (id: string) => scenario.steps.findIndex(step => step.id === id) + 1
  const parents = new Set(scenario.steps.find(step => step.id === selected)?.needs ?? [])
  const children = new Set(scenario.steps.filter(step => step.needs.includes(selected)).map(step => step.id))
  return <Stack gap="sm">
    <Row gap="sm" wrap>
      <Heading level={2}>{t("Graph editor")}</Heading>
      <Badge>{scenario.steps.length} {t("steps")}</Badge><Badge>{layers.length} {t("waves")}</Badge>
      <Badge>{new Set(scenario.steps.map(step => step.agent)).size} {t("agents")}</Badge>
      <Button size="sm" variant="outline" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, read(editorSelection), undefined, read(language)), true)}>{t("Add step")}</Button>
      <Button size="sm" variant="outline" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, read(editorSelection), undefined, read(language)), true)}>{t("Add child")}</Button>
      <Button size="sm" variant="outline" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, undefined, undefined, read(language)), true)}>{t("Add parallel step")}</Button>
      <Button size="sm" variant="ghost" disabled={locked} onPress={() => mutateGraph(graph => insertStep(graph, undefined, read(editorSelection), read(language)), true)}>{t("Duplicate")}</Button>
    </Row>
    <Text muted size="xs">{t("Read from top to bottom. Steps in the same wave can run in parallel. Each waits only for its own predecessors. Select a connection to see its predecessor.")}</Text>
    <Stack gap="md">
      {layers.map((layer, index) => <Stack gap="sm">
        {index ? <Text muted size="sm">{t("↓ Dependent steps")}</Text> : null}
        <Heading level={3}>{t("Wave {0} · {1}", index + 1, layer.length === 1 ? t("single step") : t("parallel"))}</Heading>
        <Box gap="sm" padding="sm" border radius="md" background="muted">
          {layer.map(step => <Box gap="xs" padding="sm" radius="sm" border={selected === step.id || parents.has(step.id) || children.has(step.id) ? 'accent' : true} background={selected === step.id ? 'accent' : 'card'}>
            <Row gap="xs" wrap>
              <Badge tone={selected === step.id ? 'accent' : 'neutral'}>{`#${number(step.id)}`}</Badge>
              {selected === step.id ? <Badge tone="accent">{t("Selected")}</Badge> : parents.has(step.id) ? <Text size="xs">{t("Predecessor of selection")}</Text> : children.has(step.id) ? <Text size="xs">{t("Follows selection")}</Text> : null}
            </Row>
            <Link onPress={() => selectNode(step.id)}>{step.title}</Link>
            <Text muted size="xs">{step.id} · {step.agent}</Text>
            {step.needs.length ? <Stack gap="xs">
              <Text muted size="xs">{step.join === 'all_settled' ? t("↓ After all finish:") : t("↓ After all succeed:")}</Text>
              <Row gap="xs" wrap>
                {step.needs.map(id => <Button size="sm" variant="outline" tooltip={scenario.steps.find(item => item.id === id)?.title ?? id} onPress={() => selectNode(id)}>{`#${number(id)} → #${number(step.id)}`}</Button>)}
              </Row>
            </Stack> : <Text muted size="xs">{t("Independent start")}</Text>}
            {step.when ? <Text muted size="xs">{t("Condition: {0}", conditionLabel(step.when, read(language)))}</Text> : null}
            <Row gap="xs" wrap>
              {step.fallback.length ? <Badge tone="warning">{`Fallback: ${step.fallback.join(' → ')}`}</Badge> : null}
              {step.reviewAgent ? <Badge tone="accent">{`Evidence Gate: ${step.reviewAgent}`}</Badge> : null}
              {step.approval ? <Badge tone="warning">Approval</Badge> : null}
              {step.placement.host !== 'local' ? <Badge tone="accent">{`Remote: ${step.placement.host}`}</Badge> : null}
            </Row>
          </Box>)}
        </Box>
      </Stack>)}
    </Stack>
  </Stack>
}

async function openGraph(): Promise<void> {
  if (viewingRun()) return
  await action(async () => {
    await plugin.request('editor.open', { workspaceId: read(workspaceId), source: read(draft) })
  })
}

function RepositoryFiles() {
  const id = read(workspaceId)
  const name = read(fileName)
  const names = read(fileNames)
  const selected = read(data)?.workspaces.find(item => item.id === id)
  if (!selected) return null
  if (selected.hostId && selected.hostId !== 'local') return <Collapsible title={t("Repository scenarios")}>
    <Text>{t("To open or save a YAML file, select a workspace on the coordinator host.")}</Text>
  </Collapsible>
  return <Collapsible title={t("Repository scenarios")}>
    <Stack gap="sm">
      <Button disabled={read(busy)} onPress={() => action(async () => {
        const result = await plugin.request('scenario.files', { workspaceId: id })
        if (id === read(workspaceId)) set(fileNames, result.names)
      })}>{t("Browse pipelines/")}</Button>
      {names?.length ? <Select label={t("Repository file")} value={names.includes(name) ? name : ''} placeholder={t("Choose a YAML file")}
        options={names.map(value => ({ value, label: value }))} onChange={value => { set(fileName, value); set(fileStatus, '') }} /> : null}
      {names?.length === 0 ? <Text muted>{t("No YAML files in pipelines/ yet.")}</Text> : null}
      <Input label={t("Filename in pipelines/")} value={name} placeholder="release.yaml" onChange={value => { set(fileName, value); set(fileStatus, '') }} />
      <Row gap="xs" wrap>
        <Button disabled={!name || read(busy)} onPress={() => action(async () => {
          const before = read(draft)
          const { source } = await plugin.request('scenario.open', { workspaceId: id, name })
          if (id !== read(workspaceId) || name !== read(fileName)) return
          if (before !== read(draft)) throw new Error(t('The draft changed while opening the file. Open it again to replace the draft.'))
          syncDraft(source)
          set(openedFile, { workspaceId: id, name, source })
          set(template, 'custom')
          set(fileStatus, t('Opened pipelines/{0}', name))
        })}>{t("Open file")}</Button>
        <Button disabled={!name || read(busy) || !!read(draftError)} onPress={() => action(async () => {
          const source = read(draft)
          const opened = read(openedFile)
          const previous = opened?.workspaceId === id && opened.name === name ? opened.source : null
          await plugin.request('scenario.save', { workspaceId: id, name, source, previous })
          if (id !== read(workspaceId) || name !== read(fileName)) return
          set(openedFile, { workspaceId: id, name, source })
          if (names) set(fileNames, [...new Set([...names, name])].sort())
          set(fileStatus, t('Saved pipelines/{0}', name))
        })}>{t("Save file")}</Button>
      </Row>
      {read(fileStatus) ? <Text size="sm">{read(fileStatus)}</Text> : null}
    </Stack>
  </Collapsible>
}

function RunPreview() {
  const scenario = read(runScenario)
  const workspace = read(data)?.workspaces.find(item => item.id === read(workspaceId))
  if (!scenario || !workspace) return null
  return <Collapsible title={t("Run preview")}>
    <Stack gap="sm">
      <Text muted>{t("Agents are listed in preference order. Available quota at dispatch can change the selection.")}</Text>
      {waves(scenario.steps).map((wave, index) => <Stack gap="xs">
        <Heading level={3}>{t('Wave {0}', index + 1)}</Heading>
        {wave.map(step => <Card title={step.title} description={step.id}>
          <KeyValue items={[
            { label: t("Agent order"), value: [step.agent, ...step.fallback].join(' → ') },
            { label: t("Host"), value: step.placement.host },
            { label: t("Worktree"), value: step.placement.worktree === 'current' ? (supportsSeparateWorkspace(workspace) && read(separateWorkspace) ? t('New copy of {0}', workspace.path) : workspace.path) : [step.placement.repo, step.placement.worktree, step.placement.name].filter(Boolean).join(' · ') },
            ...(step.model ? [{ label: t("Model"), value: [step.model, step.effort].filter(Boolean).join(' · ') }] : []),
            ...(step.approval ? [{ label: t("Approval"), value: step.approval }] : [])
          ]} />
          <CodeView code={step.acceptance.join('\n')} wrap />
        </Card>)}
      </Stack>)}
      {scenario.pullRequest ? <Text>{t('Pull request into {0}', scenario.pullRequest.base) + (scenario.pullRequest.merge ? ' · ' + t('Merge approval: {0}', scenario.pullRequest.mergeApproval) : '')}</Text> : null}
    </Stack>
  </Collapsible>
}

function ProjectView() {
  const dashboard = read(data)
  const disabled = read(busy) || !dashboard?.workspaces.length
  return <Stack gap="md">
      <Text muted>{t("Choose a project and describe the task. The planner will create the YAML and open it in a separate Orca tab.")}</Text>
      <Grid minItemWidth="sm" gap="sm">
        <Select
          label={t("Project")}
          value={read(workspaceId)}
          options={dashboard?.projects?.length ? dashboard.projects.map(project => ({ value: project.workspaceId, label: project.name })) : dashboard?.workspaces.map(workspace => ({ value: workspace.id, label: workspace.name })) ?? []}
          placeholder={t("Choose a project")}
          onChange={(value) => {
            set(workspaceId, value)
            set(fileName, ''); set(fileNames, null); set(openedFile, null); set(fileStatus, '')
            update(data, previous => previous ? { ...previous, runs: [], beads: [], plans: [], beadsError: undefined, metrics: metricsForRuns([]) } : null)
            set(error, null)
            set(plan, null)
            syncDraft(read(projectDrafts)[value] ?? defaultScenario(read(language)))
            set(separateWorkspace, supportsSeparateWorkspace(dashboard?.workspaces.find(item => item.id === value)))
            void refresh(value)
          }}
        />
        <Select
          label={t("Template")}
          value={read(template)}
          options={[
            { value: 'custom', label: t("Custom scenario") },
            { value: 'implement-review', label: t("Implementation → evidence gate") },
            { value: 'bugfix-regression', label: 'Bugfix → regression test' },
            { value: 'research-design', label: 'Research → design → implementation' }
          ]}
          onChange={(value) => {
            set(template, value)
            if (value !== 'custom') {
              syncDraft(scenarioTemplate(value, read(language)))
            }
          }}
        />
      </Grid>
      <TemplateLibrary project={dashboard?.workspaces.find(item => item.id === read(workspaceId))?.path ?? ''} draft={read(draft)} apply={source => { syncDraft(source); set(openedFile, null); set(fileName, ''); set(stage, 'steps') }} t={t} />
      <RepositoryFiles />
      <Collapsible title={t("Plan with an agent")} defaultOpen>
        <Stack gap="sm">
          <Textarea label={t("Objective")} rows={3} value={read(objective)} placeholder={t("What needs to be done, and how will you check the result?")} onChange={(value) => set(objective, value)} />
          <Row gap="sm" align="end" wrap>
            <Select
              label="Planner"
              value={read(plannerAgent)}
              options={agentOptions(read(data)?.agents, [read(plannerAgent)])}
              onChange={(value) => { set(plannerAgent, value); set(plannerModel, ''); set(plannerEffort, '') }}
            />
            <Button variant="outline" icon="agent" disabled={disabled || read(plan)?.status === 'running'} onPress={generatePlan}>{t("Generate YAML")}</Button>
            {read(plan)?.status === 'running' ? <Badge tone="accent">{t("Planner is working…")}</Badge> : null}
            {read(plan)?.status === 'done' ? <Badge tone="success">{t("YAML updated")}</Badge> : null}
          </Row>
          {read(plan)?.error ? <Callout tone="danger" title="Planner"><Text>{diagnosis(read(plan)?.error)}</Text></Callout> : null}
        </Stack>
      </Collapsible>
      <ModelChoice agent={read(plannerAgent)} scope="Planner" model={read(plannerModel)} effort={read(plannerEffort)} onChange={preferences => { set(plannerModel, preferences.model ?? ''); set(plannerEffort, preferences.effort ?? '') }} />
      <PlannerSummary />
      <Collapsible title={t("Name and objective · {0}", read(validated)?.name ?? t("Scenario"))}>
        <Stack gap="sm">
          <Input label="Scenario name" value={read(scenarioName)} onChange={value => set(scenarioName, value)} />
          <Textarea label="Scenario objective" rows={2} value={read(scenarioObjective)} onChange={value => set(scenarioObjective, value)} />
          <Button disabled={!!read(draftError)} onPress={() => mutateGraph(graph => ({ ...graph, name: read(scenarioName), objective: read(scenarioObjective) }))}>{t("Apply name and objective")}</Button>
        </Stack>
      </Collapsible>
      <Row gap="sm" wrap>
        <Button disabled={disabled || read(plan)?.status === 'running'} icon="next" onPress={() => set(stage, 'steps')}>{t("Next: steps and agents")}</Button>
        <Button variant="ghost" icon="refresh" disabled={read(busy)} onPress={() => refresh()}>{t("Refresh")}</Button>
      </Row>
  </Stack>
}

function StepsView() {
  return <Stack gap="md">
      <Row gap="sm" wrap>
        <Button variant="outline" disabled={read(busy) || !!read(draftError)} onPress={openGraph}>{t("Open editor in a tab")}</Button>
        <Button variant="ghost" onPress={() => set(stage, 'project')}>{t("Back: project and task")}</Button>
        <Button variant="outline" icon="check" disabled={read(busy)} onPress={() => action(async () => {
          await plugin.request('scenario.validate', { source: read(draft) })
          syncDraft(read(draft))
        })}>{t("Validate YAML")}</Button>
        <Button icon="next" disabled={read(busy) || !!read(draftError)} onPress={() => set(stage, 'monitor')}>{t("Next: launch")}</Button>
      </Row>
      {read(draftError) ? <Callout tone="danger" title={t("Invalid YAML · showing the last valid graph")}><Text>{diagnosis(read(draftError))}</Text></Callout> : null}
      {read(editError) ? <Callout tone="danger" title={t("Change could not be applied")}><Text>{diagnosis(read(editError))}</Text></Callout> : null}
      <RadioGroup label={t("Editor view")} orientation="horizontal" value={read(viewMode)} options={[{ value: 'map', label: t("Map") }, { value: 'yaml', label: 'YAML' }, { value: 'split', label: t("Side by side") }]} onChange={value => set(viewMode, value)} />
      <Box direction="row" gap="md" wrap width="100%" align="start">
        {read(viewMode) !== 'yaml' ? <Box width={280} maxWidth="100%" minWidth={0}>
          <GraphEditor />
        </Box> : null}
        <Box width={600} maxWidth="100%" grow minWidth={0} gap="md">
          {read(viewMode) !== 'map' ? <Textarea label={t("Scenario YAML")} rows={20} value={read(draft)} onChange={syncDraft} /> : null}
          {read(viewMode) !== 'yaml' ? <StepEditor /> : null}
        </Box>
      </Box>
  </Stack>
}

function LaunchView() {
  const scenario = read(validated)
  const workspace = read(data)?.workspaces.find(item => item.id === read(workspaceId))
  const conflicts = scenario && workspace ? workspaceRestrictionConflicts(scenario, workspace.path) : []
  const separate = supportsSeparateWorkspace(workspace) && read(separateWorkspace)
  const locationConflict = separate && conflicts.length > 0
  return <Stack gap="md">
    <Collapsible title={t("New run · {0}", scenario?.name ?? t("Scenario"))} open={read(launchExpanded) ?? true} onChange={value => set(launchExpanded, value)}>
    <Stack gap="sm">
    <KeyValue items={[
      { label: t("Project"), value: workspace?.name ?? t("Choose a project in step 1") },
      { label: t("Scenario"), value: scenario?.name ?? t("Fix the scenario in step 2") },
      { label: t("Task"), value: scenario?.objective ?? '—' },
      { label: t("Steps in run"), value: scenario?.steps.length ?? 0 },
      { label: t("Agents"), value: scenario ? [...new Set(scenario.steps.flatMap(step => [step.agent, ...step.fallback]))].join(', ') : '—' }
    ]} />
    <RunPreview />
    {read(runScenario) ? <Rehearsal plan={read(runScenario)!} t={t} /> : null}
    {supportsSeparateWorkspace(workspace) ? <Stack gap="xs">
    <Checkbox label={t("Use a separate Pipeline workspace in Orca")} checked={separate} onChange={value => set(separateWorkspace, value)} />
    <Text muted size="xs">{t("A separate workspace branches from the selected project's current commit. Uncommitted files stay in the original workspace. Turn this off to work directly in the selected folder.")}</Text>
    </Stack> : null}
    <Text size="sm">{t("Source folder: {0}", workspace?.path ?? t("none selected"))}</Text>
    <Text size="sm">{separate ? t("Agents and results will use a new copy of the project. Absolute paths in instructions stay as written.") : t("Agents and results will use the selected project folder.")}</Text>
    {locationConflict ? <Callout tone="warning" title={t("Choose where to run the tasks")}><Stack gap="sm">
      <Text>{t("Steps {0} require the folder {1}. A separate workspace would use a different folder.", conflicts.map(step => step.title).join(', '), workspace!.path)}</Text>
      <Button size="sm" onPress={() => set(separateWorkspace, false)}>{t("Use the required folder")}</Button>
      <Button size="sm" variant="outline" onPress={() => set(stage, 'steps')}>{t("Edit folder restrictions")}</Button>
    </Stack></Callout> : null}
    {read(draftError) ? <Callout tone="danger" title={t("Scenario needs changes")}><Text>{diagnosis(read(draftError))}</Text></Callout> : null}
    <Row gap="sm" wrap>
      <Button variant="ghost" onPress={() => set(stage, 'steps')}>{t("Back: steps and agents")}</Button>
      <Button icon="play" disabled={read(busy) || !workspace || !scenario || !!read(draftError) || locationConflict} onPress={start}>{t("Start run")}</Button>
    </Row>
    </Stack>
    </Collapsible>

  </Stack>
}

function ScenarioView() {
  const run = viewingRun() ? selectedRun() : undefined
  if (run) return <Tabs label={t("Pipeline stage")} value={read(stage)} onChange={value => set(stage, value)}>
    <Tab value="project" label={t("1. Project")}><StoredParameters run={run} /></Tab>
    <Tab value="steps" label={t("2. Steps")}><StoredParameters run={run} steps /></Tab>
    <Tab value="monitor" label={t("3. Launch")}><RunsView /></Tab>
  </Tabs>
  return <Tabs label={t("Pipeline stage")} value={read(stage)} onChange={value => set(stage, value)}>
    <Tab value="project" label={t("1. Project")}><ProjectView /></Tab>
    <Tab value="steps" label={t("2. Steps")}><StepsView /></Tab>
    <Tab value="monitor" label={t("3. Launch")}><LaunchView /></Tab>
  </Tabs>
}

async function openRun(run: PipelineRun, dispatchId?: string): Promise<void> {
  await action(async () => { await plugin.request('run.open', { id: run.id, ...(dispatchId ? { dispatchId } : {}) }) })
}

function activeStepId(run: PipelineRun): string {
  if (run.tasks[read(stepId)]) return read(stepId)
  return run.scenario.steps.find(step => ['running', 'retrying', 'blocked', 'failed'].includes(run.tasks[step.id]?.status))?.id ?? run.scenario.steps[0]?.id
}

function MessageInput({ run, step, questionId }: { run: PipelineRun; step: string; questionId?: string }) {
  const key = `${run.id}:${step}:${questionId ?? 'message'}`
  const value = read(messageDrafts)[key]
  return <Stack gap="sm">
    <Textarea label={questionId ? t("Reply to agent") : t("Message to agent")} value={value?.text ?? ''} rows={3} onChange={text => update(messageDrafts, previous => ({ ...previous, [key]: { id: previous[key]?.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2)}`, text } }))} />
    <Button size="sm" disabled={read(busy) || !value?.text.trim()} onPress={() => action(async () => {
      const draft = read(messageDrafts)[key]
      if (!draft?.text.trim()) return
      const result = await plugin.request('run.message', { id: run.id, stepId: step, messageId: draft.id, text: draft.text, questionId })
      update(data, previous => mergeRun(previous, result.run))
      update(messageDrafts, previous => {
        if (previous[key]?.text !== draft.text) return previous
        const next = { ...previous }; delete next[key]; return next
      })
    })}>{questionId ? t("Reply") : t("Send message")}</Button>
  </Stack>
}

function AttemptsView({ run }: { run: PipelineRun }) {
  const id = activeStepId(run)
  const task = run.tasks[id]
  const step = run.scenario.steps.find((candidate) => candidate.id === id)
  if (!task || !step) return null
  const last = task.attempts.at(-1)
  const nativeSession = run.controller !== 'terminal' || run.backend === 'orca'
  return (
    <Card title={step.title} description={step.spec}>
      <Stack gap="sm">
        <Row gap="sm" wrap>
          {statusBadge(task.status)}
          {run.controller === 'terminal' ? <Text muted>{t("Terminal run")}</Text> : null}
          {run.controller === 'terminal' && run.backend === 'local' ? <Text muted>{t("See Latest output and the pipeline terminal for results and checks.")}</Text> : last || task.startup ? <Button icon="next" onPress={() => openRun(run, task.startup?.dispatchId ?? last!.dispatchId)}>{t("Open agent session")}</Button> : <Text muted>{t("The session will appear once dependencies finish and the step starts.")}</Text>}
        </Row>
        {last?.status === 'running' && (task.activity === 'unknown' || task.waitReason) ? <Callout tone="warning" title={task.activity === 'unknown' ? t("Activity unconfirmed") : t("Agent status")}><Text>{task.waitReason ?? (run.controller === 'terminal' && run.backend === 'local' ? t("Work has not started yet or has not been confirmed. Check the executor events in the pipeline terminal.") : t("Orca accepted the task and is waiting for the agent to start. Open its session to check for an update or another prompt."))}</Text></Callout> : null}
        <Text size="sm">{t("Agent chain: {0}", [step.agent, ...step.fallback].join(' → '))}</Text>
        <KeyValue items={[
          { label: 'Task', value: task.taskId },
          { label: 'Bead', value: task.beadId ?? '—' },
          { label: 'Agent', value: task.agent },
          { label: 'Host', value: step.placement.host },
          { label: 'Workspace', value: step.placement.worktree },
          { label: 'Fallback', value: step.fallback.join(' → ') || '—' }
        ]} />
        {task.error ? <Callout tone="danger" title={t("Error")}><Text>{diagnosis(task.error)}</Text></Callout> : null}
        {task.unconfirmedStart ? <Callout tone="warning" title={t("Launch unconfirmed")}><Text>{t("Select “Diagnose and continue” above to match the agent session to its launch record. Dependent steps will wait for confirmation.")}</Text></Callout> : null}
        {task.skipReason ? <Callout title={t("Step skipped")}><Text>{task.skipReason}</Text></Callout> : null}
        {task.data ? <Collapsible title={t("Validated output")} defaultOpen><CodeView code={JSON.stringify(task.data, null, 2)} language="json" wrap /></Collapsible> : null}
        {task.activity === 'interrupted' && task.interaction === 'pi' && run.controller === 'terminal' && run.backend === 'local' ? <Button size="sm" disabled={read(busy)} onPress={() => action(async () => {
          const result = await plugin.request('run.recover', { id: run.id, stepId: id })
          update(data, previous => mergeRun(previous, result.run))
        })}>{t("Resume saved Pi session")}</Button> : null}
        {task.questions?.filter(question => question.state === 'waiting').map(question => <Callout tone="warning" title={t("Agent question")}>
          <Stack gap="sm"><Text>{question.question}</Text>
            <Text muted size="sm">{t("Reply here to continue the current attempt with the same agent.")}</Text>
            {(task.interaction === 'native' && run.controller !== 'terminal' || task.interaction === 'pi' && task.activity !== 'interrupted' && run.controller === 'terminal' && run.backend === 'local') && last?.status === 'running' ? <MessageInput run={run} step={id} questionId={question.id} /> : null}
          </Stack>
        </Callout>)}
        {task.interaction === 'pi' && task.activity !== 'interrupted' && run.controller === 'terminal' && run.backend === 'local' && last?.status === 'running' ? <Collapsible title={t("Message the Pi agent")}><MessageInput run={run} step={id} /></Collapsible> : null}
        {task.messages?.length ? <List>{task.messages.slice(-8).map(message => <ListItem title={`${message.id}: ${message.state}`} description={message.error} />)}</List> : null}
        {run.status === 'failed' && task.status === 'failed' ? <Select label={t("Agent for retry")} value={task.agent} options={agentOptions(read(data)?.agents, [task.agent])} onChange={agent => action(async () => {
          const { run: changed } = await plugin.request('run.assign-agent', { id: run.id, stepId: step.id, agent })
          update(data, previous => mergeRun(previous, changed))
        })} /> : null}
        {task.gateId && task.status === 'blocked' ? (
          <Callout tone="warning" title={t("Decision required")}>
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
                      update(data, previous => mergeRun(previous, answer.run))
                    })}
                  >{resolution === 'approve' ? t("Approve") : t("Reject")}</Button>
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
              update(data, previous => mergeRun(previous, answer.run))
            })}
          >{t("Stop and switch agent")}</Button>
        ) : null}
        {[...(task.history ?? []), task].map(revision => revision.attempts.map((next, index) => {
          const previous = revision.attempts[index - 1]
          if (!previous || previous.agent === next.agent) return null
          return <Collapsible key={next.dispatchId} title={t("Handoff · {0} → {1}", previous.agent, next.agent)}>
            <Text>{previous.failure?.message || previous.reason || next.selectionReason || t("No recorded reason")}</Text>
            {previous.output ? <CodeView code={previous.output} wrap maxHeight="sm" /> : null}
            {next.checkpointPreview ? <Stack><Text>{t("Prepared checkpoint (last 4000 characters)")}</Text><CodeView code={next.checkpointPreview} wrap maxHeight="sm" /></Stack> : <Text>{t("Checkpoint preview unavailable")}</Text>}
            {nativeSession ? <Row wrap>{[previous, next].map((item, position) => <Button onPress={() => openRun(run, item.dispatchId)}>{t(position === 0 ? "Open previous session · {0}" : "Open next session · {0}", item.agent)}</Button>)}</Row> : null}
          </Collapsible>
        }))}
        <Collapsible title={t("Attempts: {0}", task.attempts.length)} defaultOpen={task.attempts.length > 1}>
          <List>
            {task.attempts.map((attempt, index) => (
              <ListItem
                title={`${index + 1}. ${attempt.agent} · ${attempt.status}`}
                description={`${attempt.startedAt}${attempt.reason ? ` · ${attempt.reason}` : ''}${attempt.selectionReason ? ` · ${attempt.selectionReason}` : ''}`}
                onPress={nativeSession ? () => openRun(run, attempt.dispatchId) : undefined}
              />
            ))}
          </List>
        </Collapsible>
        {task.history?.map(revision => <Collapsible title={t("Previous inputs for {0}: {1}", revision.revision, revision.status)}>
          <List>{revision.attempts.map(attempt => <ListItem title={`${attempt.agent} · ${attempt.status}`} description={attempt.artifactPath ?? attempt.dispatchId} onPress={nativeSession ? () => openRun(run, attempt.dispatchId) : undefined} />)}</List>
          {revision.attempts.at(-1)?.output ? <CodeView code={revision.attempts.at(-1)!.output!} maxHeight="md" wrap /> : null}
        </Collapsible>)}
        {last?.output ? <Collapsible title={t("Latest output")}><CodeView code={last.output} maxHeight="md" wrap /></Collapsible> : null}
        <Collapsible title="Acceptance">
          <List>{step.acceptance.map((command, index) => {
            const check = last?.checks?.[index]
            const recorded = check?.command === command
            return <ListItem title={command} description={recorded ? check.exitCode === null ? t("Check outcome unknown") : t("Exit code: {0}", check.exitCode) : t("No check result recorded")} />
          })}</List>
        </Collapsible>
      </Stack>
    </Card>
  )
}

// Stages describe dependency depth, not a scheduler barrier: each step only waits for its own inputs.
function RunDependencies({ run }: { run: PipelineRun }) {
  const layers = waves(run.scenario.steps)
  const number = (id: string) => run.scenario.steps.findIndex(step => step.id === id) + 1
  const selected = activeStepId(run)
  const parents = new Set(run.scenario.steps.find(step => step.id === selected)?.needs ?? [])
  const children = new Set(run.scenario.steps.filter(step => step.needs.includes(selected)).map(step => step.id))
  return <Stack gap="sm">
    <Heading level={3}>{t("Order and dependencies")}</Heading>
    <Text muted size="xs">{t("Read from top to bottom. Steps in the same stage can run in parallel. Each waits only for its own predecessors.")}</Text>
    <Button size="sm" variant="ghost" onPress={() => set(stepId, '')}>{t("Follow active step")}</Button>
    {layers.map((layer, index) => <Stack gap="sm">
      {index ? <Text muted size="sm">{t("↓ Dependent steps")}</Text> : null}
      <Row gap="xs" wrap>
        <Text size="sm" weight="semibold">{t("Stage {0}", index + 1)}</Text>
        <Badge tone={layer.length > 1 ? 'accent' : 'neutral'}>{layer.length > 1 ? t("Independent: {0}", layer.length) : t("1 step")}</Badge>
      </Row>
      <Box gap="sm" padding="sm" border radius="md" background="muted">
        {layer.map(step => {
          const task = run.tasks[step.id]
          const attempt = task?.attempts.at(-1)
          const dispatch = attempt?.status === 'running' ? attempt.dispatchId : undefined
          const unmet = step.needs.filter(id => {
            const status = run.tasks[id]?.status
            return status !== 'done' && !(step.join === 'all_settled' && (status === 'failed' || status === 'skipped'))
          })
          const current = selected === step.id
          return <Box gap="xs" padding="sm" radius="sm" border={current ? 'accent' : parents.has(step.id) || children.has(step.id) ? 'accent' : true} background={current ? 'accent' : 'card'}>
            <Row gap="xs" wrap>
              <Badge tone={current ? 'accent' : 'neutral'}>{`#${number(step.id)}`}</Badge>
              <Badge tone={task ? STATUS[task.status].tone : 'neutral'}>{task ? t(STATUS[task.status].label) : t("Waiting")}</Badge>
              {current ? <Text size="xs">{t("Selected")}</Text> : parents.has(step.id) ? <Text size="xs">{t("Predecessor of selection")}</Text> : children.has(step.id) ? <Text size="xs">{t("Follows selection")}</Text> : null}
            </Row>
            <Link onPress={() => set(stepId, step.id)}>{`${step.title} · ${task?.agent ?? step.agent}`}</Link>
            <Text muted size="xs">{t("{0} · attempts: {1}", task?.agent ?? step.agent, task?.attempts.length ?? 0)}</Text>
            {task?.status === 'running' && task.activity && task.activityObservedAt ? <Text size="xs">{t("Last observation · {0} · {1}", task.activity, task.activityObservedAt)}</Text> : null}
            {task?.questions?.some(question => question.state === 'waiting') ? <Text tone="warning" size="sm">{t("An agent needs your reply")}</Text> : null}
            {unmet.length > 0 && (task?.status === 'pending' || task?.status === 'blocked') ? <Text size="xs">{t("Waiting for {0}", unmet.map(id => run.scenario.steps.find(input => input.id === id)?.title ?? id).join(', '))}</Text> : null}
            {task?.gateId && task.status === 'blocked' ? <Text tone="warning" size="xs">{t("Decision required")}</Text> : null}
            {task?.unconfirmedStart ? <Text tone="warning" size="sm">{t("Launch unconfirmed")}</Text> : null}
            {task?.skipReason ? <Text muted size="xs">{diagnosis(task.skipReason)}</Text> : null}
            {task?.status === 'running' && task.waitReason ? <Text size="xs">{task.waitReason}</Text> : null}
            {dispatch && (run.controller !== 'terminal' || run.backend === 'orca') ? <Button size="sm" onPress={() => openRun(run, dispatch)}>{t("Open {0} session", task.agent)}</Button> : null}
            {step.needs.length ? <Stack gap="xs">
              <Text muted size="xs">{step.join === 'all_settled' ? t("↓ After all finish:") : t("↓ After all succeed:")}</Text>
              {step.needs.map(id => <Button size="sm" variant="ghost" tooltip={run.scenario.steps.find(item => item.id === id)?.title ?? id} onPress={() => set(stepId, id)}>{`#${number(id)} → #${number(step.id)} · ${run.tasks[id] ? t(STATUS[run.tasks[id].status].label) : t("Waiting")}`}</Button>)}
            </Stack> : <Text muted size="xs">{t("Independent start")}</Text>}
            {step.when ? <Text muted size="xs">{t("Condition: {0}", conditionLabel(step.when, read(language)))}</Text> : null}
            {step.approval ? <Text tone="warning" size="xs">{t("Manual approval required")}</Text> : null}
          </Box>
        })}
      </Box>
    </Stack>)}
  </Stack>
}

function RunsView() {
  const dashboard = read(data)
  if (!selectedRun()) return <EmptyState icon="activity" title={t("No runs yet")} description={t("Select Start run above to see steps, statuses and agent sessions here.")} />
  const run = selectedRun()!
  const tasks = run.scenario.steps.map((step) => run.tasks[step.id]).filter(Boolean)
  const { completed, failed, active, waiting, skipped } = countRunSteps(run)
  const draftSource = read(projectDrafts)[run.sourceWorkspaceId ?? run.workspaceId] ?? read(draft)
  return (
    <Stack gap="md">
      {tasks.some(task => task.questions?.some(question => question.state === 'waiting')) ? <Callout tone="warning" title={t("An agent needs your reply")}><Stack gap="sm"><Text>{t("Open the question and reply here. Completed steps are saved.")}</Text>{run.scenario.steps.filter(step => run.tasks[step.id]?.questions?.some(question => question.state === 'waiting')).map(step => <Button size="sm" onPress={() => set(stepId, step.id)}>{t("Reply: {0}", step.title)}</Button>)}</Stack></Callout> : null}
      {run.status === 'failed' ? <Callout tone="danger" title={t("Execution stopped")}><Stack gap="sm">
        {run.scenario.steps.filter(step => run.tasks[step.id]?.status === 'failed').map(step => <Stack gap="xs"><Text>{`${step.title}: ${run.tasks[step.id].error ?? run.tasks[step.id].attempts.at(-1)?.reason ?? t("A step failed. Open its output and checks for details.")}`}</Text><Button size="sm" variant="outline" onPress={() => set(stepId, step.id)}>{t("Inspect failure: {0}", step.title)}</Button></Stack>)}
        <Text size="sm">{t("A reply continues the current attempt. Retrying or switching agents starts a new attempt for the failed step.")}</Text>
      </Stack></Callout> : null}
      <Row justify="between" align="center" wrap>
        <Stack gap="xs">
          <Heading level={2}>{run.scenario.name}</Heading>
          <Text muted size="xs">{run.runId}</Text>
        </Stack>
        <Badge tone={run.status === 'done' ? 'success' : run.status === 'failed' ? 'danger' : 'accent'}>{({ running: t("Running"), paused: t("On hold"), done: t("Completed"), failed: t("Failed"), cancelled: t("Cancelled") })[run.status]}</Badge>
      </Row>
      <Progress label={t("Successful: {0} of {1}{2}", completed, run.scenario.steps.length, skipped ? t(" · skipped: {0}", skipped) : '')} value={run.scenario.steps.length ? 100 * completed / run.scenario.steps.length : 0} />
      <Row gap="sm" wrap>
        <Badge tone="success">{t("Successful: {0}", completed)}</Badge>
        <Badge tone={failed ? 'danger' : 'neutral'}>{t("Errors: {0}", failed)}</Badge>
        <Badge tone={active ? 'accent' : 'neutral'}>{t("Active: {0}", active)}</Badge>
        <Badge>{t("Waiting: {0}", waiting)}</Badge>
        {skipped ? <Badge>{t("Skipped: {0}", skipped)}</Badge> : null}
        <Button size="sm" variant="outline" onPress={() => set(tab, 'result')}>{run.status === 'done' ? t("View result") : t("View available results")}</Button>
      </Row>
      {run.pr ? <Callout tone={run.pr.status === 'failed' ? 'danger' : run.pr.status === 'merged' ? 'success' : 'accent'} title={`PR: ${run.pr.status}`}><Text size="sm">{run.pr.url}</Text></Callout> : null}
      <Row gap="xs" wrap>
        <Button size="sm" variant="outline" icon="next" onPress={() => openRun(run)}>{t("Open Pipeline workspace")}</Button>
        {run.status === 'running' ? <Button size="sm" variant="outline" icon="pause" onPress={() => runCommand('pause', run.id)}>{t("Paused")}</Button> : null}
        {run.status === 'paused' && !needsRecovery(run) ? <Button size="sm" icon="play" onPress={() => runCommand('resume', run.id)}>{t("Resume")}</Button> : null}
        {run.status === 'failed' && !needsRecovery(run) && Object.values(run.tasks).some(task => task.unconfirmedStart || task.attempts.at(-1)?.status === 'running') ? <Button size="sm" onPress={() => runCommand(Object.values(run.tasks).some(task => task.unconfirmedStart) ? 'resume' : 'tick', run.id)}>{Object.values(run.tasks).some(task => task.unconfirmedStart) ? t("Reconcile unfinished launch") : t("Check active agents")}</Button> : null}
        {run.status === 'failed' && !needsRecovery(run) ? <Button size="sm" icon="next" onPress={() => runCommand('retry', run.id)}>{tasks.some(task => task.status === 'failed' && (!task.attempts.length || task.retrySameAgent)) ? t("Retry run") : t("Next fallback agent")}</Button> : null}
        {run.status === 'failed' && !run.controller && read(validated)?.name === run.scenario.name ? <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => action(async () => {
          const { run: configured } = await plugin.request('run.apply-agents', { id: run.id, source: draftSource })
          update(data, previous => mergeRun(previous, configured))
        })}>{t("Apply draft agents")}</Button> : null}
        <Button size="sm" variant="ghost" icon="refresh" onPress={() => runCommand('tick', run.id)}>{t("Refresh")}</Button>
        {run.status === 'running' || run.status === 'paused' ? <Button size="sm" variant="ghost" tone="danger" icon="stop" onPress={() => runCommand('cancel', run.id)}>{t("Stop")}</Button> : null}
      </Row>
      {run.excludedSteps?.length ? <Collapsible title={t("Excluded steps: {0}", run.excludedSteps.length)}><List>{run.excludedSteps.map(entry => <ListItem title={t("{0} · original status: {1}", entry.step.title, entry.task.status)} description={entry.reason} />)}</List></Collapsible> : null}
      {run.error ? <Callout tone="danger" title="Coordinator"><Text>{diagnosis(run.error)}</Text></Callout> : null}
      <Separator />
      <Box direction="row" wrap gap="md" align="start" width="100%">
      <Box width={320} minWidth={0} maxWidth="100%" grow>
        <RunDependencies run={run} />
      </Box>
      <Box width={600} maxWidth="100%" grow minWidth={0}><AttemptsView run={run} /></Box>
      </Box>
    </Stack>
  )
}

function MetricsView() {
  const dashboard = read(data)
  if (!dashboard) return <EmptyState icon="bar-chart-3" title={t("No metrics yet")} description={t("Start a pipeline to see its statistics")} />
  const metrics = dashboard.metrics
  const minutes = Math.round(metrics.durationMs / 60_000)
  return (
    <Stack gap="md">
      <Heading level={2}>{t("Metrics")}</Heading>
      <KeyValue items={[
        { label: t("Duration"), value: t("{0} min", minutes) },
        { label: t("Attempts"), value: metrics.attempts },
        { label: 'Failovers', value: metrics.failovers },
        { label: t("Steps in run"), value: `${metrics.completedSteps}/${metrics.totalSteps}${metrics.skippedSteps ? t(" · skipped: {0}", metrics.skippedSteps) : ''}` },
        { label: t("Success"), value: `${metrics.successRate}%` }
      ]} />
      <Table
        label={t("By agent")}
        columns={[
          { key: 'agent', label: t("Agent") },
          { key: 'attempts', label: t("Attempts"), width: 'sm' },
          { key: 'succeeded', label: t("Success"), width: 'sm' },
          { key: 'failed', label: t("Errors"), width: 'sm' }
        ]}
        rows={metrics.byAgent.map((row) => ({ key: row.agent, cells: row }))}
        emptyText={t("No attempts yet")}
      />
      <Collapsible title={t("Run timeline")}>
        <List>
          {dashboard.runs.map((run) => (
            <ListItem
              title={`${run.scenario.name} · ${run.status}`}
              description={t("{0} → {1} · {2} attempts", run.createdAt, run.updatedAt, Object.values(run.tasks).reduce((sum, task) => sum + task.attempts.length, 0))}
              icon="activity"
            />
          ))}
        </List>
      </Collapsible>
    </Stack>
  )
}

function TasksView() {
  const dashboard = read(data)
  const query = read(taskSearch).trim().toLowerCase()
  const tasks = (dashboard?.runs ?? []).flatMap(run => run.scenario.steps.flatMap(step => {
    const task = run.tasks[step.id]
    return task ? [{ run, step, task, key: `${run.id}::${step.id}` }] : []
  }))
  const filtered = tasks.filter(({ run, step, task }) =>
    (read(taskStatus) === 'all' || task.status === read(taskStatus)) &&
    (!query || `${step.title} ${run.scenario.name} ${task.agent}`.toLowerCase().includes(query)))
  return <Stack gap="md">
    <Row justify="between" align="center" wrap>
      <Heading level={2}>{t("Pipeline tasks")}</Heading>
      <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>{t("Refresh")}</Button>
    </Row>
    <Text muted size="sm">{t("Steps from runs in the selected project. Statuses update automatically. Select a task to see its result or answer an agent.")}</Text>
    {tasks.length ? <Stack gap="sm">
      <Row gap="sm" wrap>
        <Badge>{t("Total: {0}", tasks.length)}</Badge>
        <Badge tone="accent">{t("Active: {0}", tasks.filter(({ task }) => ['running', 'retrying'].includes(task.status)).length)}</Badge>
        <Badge tone="success">{t("Finished: {0}", tasks.filter(({ task }) => task.status === 'done').length)}</Badge>
        <Badge tone="danger">{t("Errors: {0}", tasks.filter(({ task }) => task.status === 'failed').length)}</Badge>
      </Row>
      <Input label={t("Search pipeline tasks")} type="search" value={read(taskSearch)} placeholder={t("Task, run or agent")} onChange={value => set(taskSearch, value)} />
      <Select label={t("Pipeline task status")} value={read(taskStatus)} options={[{ value: 'all', label: t("All statuses") }, ...Object.entries(STATUS).map(([value, item]) => ({ value, label: t(item.label) }))]} onChange={value => set(taskStatus, value)} />
      <Table label={t("Pipeline tasks")} columns={[
        { key: 'status', label: t("Status"), width: 'sm' }, { key: 'title', label: t("Task") },
        { key: 'run', label: t("Execution"), hideBelow: 'sm' }, { key: 'agent', label: t("Agent"), width: 'sm' }
      ]} rows={filtered.map(({ key, run, step, task }) => ({ key, cells: {
        status: task.questions?.some(question => question.state === 'waiting') ? t("Awaiting reply") : t(STATUS[task.status].label),
        title: step.title, run: run.scenario.name, agent: task.agent
      } }))} emptyText={t("No tasks match these filters")} maxHeight="lg" onRowAction={({ key }) => {
        const item = tasks.find(task => task.key === key)
        if (!item) return
        set(runId, item.run.id); set(runMode, 'existing'); set(stepId, item.step.id); set(stage, 'monitor'); set(tab, 'scenario')
      }} />
    </Stack> : <EmptyState icon="activity" title={t("Tasks appear after launch")} description={t("Start a pipeline to see its steps here. The built-in list works without an external tracker.")} />}
    <Separator />
    <Collapsible title={t("External Beads tracker · {0}", dashboard?.beadsEnabled ? dashboard.beadsError ? t("setup needed") : t("enabled") : t("optional"))}>
      <Stack gap="sm">
        <Text muted size="sm">{t("Beads tracks project issues through bd. Connect it if your team already uses it. Pipeline runs, dependencies and results work independently.")}</Text>
        {dashboard?.beadsEnabled || dashboard?.beads.length || dashboard?.beadsError ? <BeadsView /> : <Box padding="md" border radius="md" gap="sm">
          <Text weight="medium">{t("Integration off")}</Text>
          <Text size="sm">{t("Enable External Beads tracker in Settings → Plugins → Agent Pipeline and enter the path to bd. Configure Beads in the selected project.")}</Text>
        </Box>}
      </Stack>
    </Collapsible>
  </Stack>
}

function BeadsView() {
  const dashboard = read(data)
  if (dashboard?.beadsError && !dashboard.beads.length) return <Stack gap="sm">
    <Text weight="medium">{t("Beads is unavailable")}</Text>
    <Text size="sm">{t("Pipeline tasks are available above. Check the bd path in Settings → Plugins → Agent Pipeline and the Beads configuration in the selected project.")}</Text>
    <Button size="sm" variant="outline" icon="refresh" onPress={() => refresh()}>{t("Test connection")}</Button>
    <Collapsible title={t("Technical details")}><Text muted size="sm">{dashboard.beadsError}</Text></Collapsible>
  </Stack>
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
      <Row justify="between" align="center" wrap>
        <Heading level={2}>Beads</Heading>
        <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>{t("Refresh")}</Button>
      </Row>
      <Input label={t("Search issues")} type="search" value={read(beadSearch)} placeholder={t("Title or ID")} onChange={(value) => set(beadSearch, value)} />
      <Row gap="sm" wrap>
        <Select
          label={t("Status")}
          value={status}
          options={['all', 'open', 'in_progress', 'blocked', 'closed'].map((value) => ({ value, label: value === 'all' ? t("All") : value }))}
          onChange={(value) => set(beadStatus, value)}
        />
        <Select
          label="Epic"
          value={epic}
          options={[{ value: 'all', label: t("All epics") }, ...epics.map((item) => ({ value: item.id, label: item.title }))]}
          onChange={(value) => set(beadEpic, value)}
        />
      </Row>
      {epics.length ? (
        <List label="Epic progress">
          {epics.map((item) => {
            const children = all.filter((bead) => bead.parentId === item.id)
            const closed = children.filter((bead) => bead.status === 'closed').length
            return <ListItem title={item.title} description={t("{0}/{1} closed", closed, children.length)} icon="layers" />
          })}
        </List>
      ) : null}
      {dashboard?.beadsError ? (
        <Callout tone="warning" title={t("bd unavailable")}>
          <Text size="sm">{dashboard.beadsError}{t(". Set the bd path in Settings → Plugins → Agent Pipeline.")}</Text>
        </Callout>
      ) : null}
      <Text muted size="xs">{t("Select an open issue to claim or close it, or a closed issue to reopen it.")}</Text>
      <Table
        label={t("Beads issues")}
        columns={[
          { key: 'status', label: t("Status"), width: 'sm' },
          { key: 'title', label: t("Task") },
          { key: 'type', label: t("Type"), width: 'xs', hideBelow: 'sm' },
          { key: 'priority', label: 'P', width: 'xs', hideBelow: 'sm' }
        ]}
        rows={beads.map((bead) => ({
          key: bead.id,
          cells: { status: bead.status, title: `${bead.title} · ${bead.id}`, type: bead.issueType ?? 'task', priority: bead.priority ?? '—' }
        }))}
        emptyText={t("No issues found")}
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
  if (read(tab) === 'runs') {
    set(tab, 'scenario')
    set(stage, 'monitor')
  }
  let languageRevision = 0
  const loadLanguage = async () => {
    const revision = ++languageRevision
    const saved = await settings.get('interfaceLanguage').catch(() => undefined)
    if (revision !== languageRevision) return
    set(language, languageOf(saved))
    syncInitialDraft()
  }
  const syncInitialDraft = () => {
    if (!read(validated) && !read(draftError)) syncDraft(read(draft) === UNINITIALIZED_DRAFT ? defaultScenario(read(language)) : read(draft))
  }
  ctx.subscriptions.push(settings.onDidChange(({ key }) => { if (key === 'interfaceLanguage') void loadLanguage() }))
  void loadLanguage()
  ctx.subscriptions.push(plugin.on('recovery.changed', ({ report }) => set(recoveryReport, report)))
  ctx.subscriptions.push(plugin.on('run.changed', ({ run }) => {
    update(data, previous => mergeRun(previous, run))
  }))
  ctx.subscriptions.push(plugin.on('scenario.changed', ({ source, workspaceId: target }) => { if (target) set(workspaceId, target); syncDraft(source); set(stage, 'steps'); set(tab, 'scenario') }))
  ctx.subscriptions.push(plugin.on('plan.changed', ({ plan: updated }) => {
    receivePlan(updated)
  }))
  void refresh()
}

export default function Panel() {
  const resultRun = viewingRun() ? selectedRun() : undefined
  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap>
        <Heading>Agent Pipeline</Heading>
        <Select label="English / Русский" value={read(language)}
          options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]}
          onChange={value => action(async () => {
            const next = languageOf(value)
            await settings.set('interfaceLanguage', next)
            set(language, next)
          })} />
        <Button size="sm" variant="ghost" disabled={read(busy)} onPress={() => refresh()}>{t("Refresh data")}</Button>
        {read(busy) ? <Badge tone="accent">{t("Working…")}</Badge> : null}
      </Row>
      <RunPicker />
      {read(error) ? <Callout tone="danger" title={t("Action failed")}><Stack gap="sm"><Text>{/unconfirmed receipt|launch outcome/i.test(read(error)!) ? recoveryExplanation(selectedRun()) : diagnosis(read(error))}</Text><Collapsible title={t("Technical error details")}><Text size="xs">{read(error)}</Text></Collapsible></Stack></Callout> : null}
      <RecoveryPanel />
      <Tabs label="Agent Pipeline" value={read(tab)} onChange={(value) => set(tab, value)}>
        <Tab value="scenario" label="Pipeline"><ScenarioView /></Tab>
        <Tab value="result" label={t("Results")}><RunResult run={resultRun} projectName={resultRun ? runProject(resultRun) : ''} language={read(language)}
          openAttempt={dispatch => resultRun && openRun(resultRun, dispatch)}
          openStep={id => { set(stepId, id); set(stage, 'monitor'); set(tab, 'scenario') }} />{resultRun ? <Stack><Comparison language={read(language)} run={resultRun} /><WorktreeReview run={resultRun} t={t} /></Stack> : null}</Tab>
        <Tab value="metrics" label={t("Metrics")}><MetricsView /></Tab>
        <Tab value="beads" label={t("Tasks")}><TasksView /></Tab>
      </Tabs>
      {read(busy) ? null : null}
    </Stack>
  )
}
