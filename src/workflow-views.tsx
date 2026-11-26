import { atom, Button, Checkbox, CodeView, Collapsible, Input, read, Row, Select, set, Stack, Text, plugin, update } from 'orca'
import { auditTemplate, compareRuns, instantiate, parameters, rehearsal } from '../packages/core/workflow-tools'
import { parseScenario } from './scenario'
import { translate, type Language, type Message } from './i18n'
import { STATUS } from './step-status'
import type { PipelineRun, Scenario } from './types'

type Labels = (key: Message, ...values: unknown[]) => string
const sampleInputs = atom<Record<string, string>>({})
const failed = atom<string[]>([])
export function resetRehearsal() { set(sampleInputs, {}); set(failed, []) }

export function Rehearsal({ plan, t }: { plan: Scenario; t: Labels }) {
  const inputs = read(sampleInputs), failures = read(failed)
  const fields = plan.steps.filter(s => s.outputSchema)
  const example = (step: Scenario['steps'][number]) => JSON.stringify(Object.fromEntries(
    Object.entries(step.outputSchema ?? {}).filter(([, f]) => f.required !== false).map(([name, f]) =>
      [name, f.enum?.[0] ?? (f.type === 'number' ? 0 : f.type === 'boolean' ? false : '')])))
  let preview
  try {
    const samples = Object.fromEntries(fields.map(step => [step.id, JSON.parse(inputs[step.id] ?? example(step))]))
    preview = Object.values(rehearsal(plan, samples, failures)).map(task => {
      const step = plan.steps.find(item => item.id === task.stepId)!
      return <Text key={step.id}>{step.title} · {t(STATUS[task.status].label)}{task.skipReason ? ' · ' + task.skipReason : ''}{step.approval && task.status !== 'skipped' ? ' · ' + t('Manual approval required') : ''}</Text>
    })
  } catch (error) { preview = <Text tone="danger">{String(error)}</Text> }
  return <Collapsible title={t('Rehearse branches')}><Stack gap="sm">
    <Text>{t('Edit simulated outputs and failures. Approvals are assumed granted.')}</Text>
    {fields.map(step => <Input label={step.id + ' · JSON'} value={inputs[step.id] ?? example(step)} onChange={v => update(sampleInputs, old => ({ ...old, [step.id]: v }))} />)}
    {plan.steps.map(step => <Checkbox label={t('Simulate failure · {0}', step.title)} checked={failures.includes(step.id)} onChange={v => set(failed, v ? [...failures, step.id] : failures.filter(id => id !== step.id))} />)}
    {preview}
  </Stack></Collapsible>
}

const library = atom<{ name: string; source: string }[]>('pipeline.parameter-library.v1', [], { persist: 'plugin' })
const chosen = atom('audit-improve-review')
const values = atom<Record<string, string>>({})
const formError = atom('')
export function TemplateLibrary({ project, draft, apply, t }: { project: string; draft: string; apply(source: string): void; t: Labels }) {
  const items = [{ name: 'audit-improve-review', source: auditTemplate }, ...read(library)]
  const item = items.find(entry => entry.name === read(chosen)) ?? items[0]
  const plan = parseScenario(item.source, { expandEvidence: false })
  const inputs = { ...read(values), project }
  return <Collapsible title={t('Reusable scenarios')}><Stack gap="sm">
    <Select label={t('Saved template')} value={item.name} options={items.map(({ name }) => ({ value: name, label: name }))} onChange={id => { set(chosen, id); set(values, {}); set(formError, '') }} />
    {parameters(plan).filter(key => key !== 'project').map(key => <Input label={key} value={read(values)[key] ?? ''} onChange={v => update(values, old => ({ ...old, [key]: v }))} />)}
    <Row wrap><Button onPress={() => {
      try { apply(instantiate(item.source, inputs)); set(formError, '') } catch (error) { set(formError, String(error)) }
    }}>{t('Create draft from template')}</Button>
    <Button variant="outline" onPress={() => {
      try {
        const name = parseScenario(draft).name
        if (items.some(entry => entry.name === name)) throw new Error(t('Choose a unique scenario name before saving'))
        set(library, [...read(library), { name, source: draft }]); set(chosen, name); set(values, {}); set(formError, '')
      } catch (error) { set(formError, String(error)) }
    }}>{t('Save draft as template')}</Button></Row>
    <Text muted>{t('Use {{focus}} in step instructions or titles. {{project}} uses the selected folder.')}</Text>
    {read(formError) ? <Text tone="danger">{read(formError)}</Text> : null}
  </Stack></Collapsible>
}

const baseline = atom<PipelineRun | null>(null)
export function Comparison({ run, language }: { run: PipelineRun; language: Language }) {
  const t: Labels = (key, ...values) => translate(language, key, ...values)
  const old = read(baseline)
  return <Collapsible title={t('Compare two runs')}><Stack gap="sm">
    <Button onPress={() => set(baseline, run)}>{t('Use this run as baseline')}</Button>
    {old ? <Text>{old.scenario.name} · {old.workspacePath} · {old.id}</Text> : null}
    {old?.id === run.id ? <Text>{t('Open the other run in history to see changes.')}</Text> : null}
    {old && old.id !== run.id ? <Stack><Text>{old.scenario.objective} → {run.scenario.objective}</Text>
      {compareRuns(old, run).map(row => <Collapsible key={row.id} title={row.id + ' · ' + t(!row.left ? 'Added step' : !row.right ? 'Removed step' : row.changed ? 'Changed' : 'Unchanged')}>
        {row.added.length ? <Stack><Text>{t('Added report lines')}</Text><CodeView code={row.added.join('\n')} wrap maxHeight="md" /></Stack> : null}
        {row.removed.length ? <Stack><Text>{t('Removed report lines')}</Text><CodeView code={row.removed.join('\n')} wrap maxHeight="md" /></Stack> : null}
        {[row.left, row.right].map((side, index) => side ? <Stack gap="xs"><Text>{t(index === 0 ? 'Baseline' : 'Selected run')} · {side.agent} · {t(STATUS[side.status].label)}</Text>
          <CodeView code={JSON.stringify({ step: side.step, checks: side.checks, filesModified: side.filesModified, review: side.review, result: side.data, error: side.error }, null, 2)} wrap maxHeight="md" />
          {side.output ? <CodeView code={side.output} wrap maxHeight="md" /> : null}</Stack> : null)}
      </Collapsible>)}</Stack> : null}
  </Stack></Collapsible>
}

const preview = atom<{ id: string; digest: string; patch: string; source: string } | null>(null)
const feedback = atom<{ id: string; message: string } | null>(null)
export function WorktreeReview({ run, t }: { run: PipelineRun; t: Labels }) {
  if (!run.reviewBase || run.status !== 'done') return null
  const current = read(preview), notice = read(feedback)
  return <Collapsible title={t('Review worktree changes')}><Stack gap="sm">
    <Button onPress={async () => {
      set(preview, null); set(feedback, null)
      try { const diff = await plugin.request('run.diff', { id: run.id }); set(preview, { id: run.id, ...diff }) }
      catch (error) { set(feedback, { id: run.id, message: String(error) }) }
    }}>{t('Preview diff')}</Button>
    {current?.id === run.id ? <Stack><Text>{current.source}</Text>
      {current.patch ? <Stack><CodeView code={current.patch} wrap maxHeight="lg" />
        <Button onPress={async () => {
          set(preview, null)
          try { await plugin.request('run.accept', { id: run.id, digest: current.digest }); set(feedback, { id: run.id, message: t('Changes staged in source project') }) }
          catch (error) { set(feedback, { id: run.id, message: String(error) }) }
        }}>{t('Stage this patch in the source project')}</Button></Stack> : <Text>{t('No file changes')}</Text>}
      </Stack> : null}
    {notice?.id === run.id ? <Text>{notice.message}</Text> : null}
  </Stack></Collapsible>
}
