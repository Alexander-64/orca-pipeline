import { atom, Button, Callout, Input, plugin, read, Row, Select, set, Stack, Text } from 'orca'
import { translate, type Language, type Message } from './i18n'
import type { PipelineRun, RunSummary, Workspace } from './types'

const expanded = atom(false)
const project = atom('')
const status = atom('')
const search = atom('')
const rows = atom<RunSummary[]>([])
const more = atom(false)
const loading = atom(false)
const error = atom('')
let revision = 0
const statuses = { running: 'Running', paused: 'Paused', done: 'Completed', failed: 'Error', cancelled: 'Cancelled' } as const

async function loadPage(append = false) {
  const request = ++revision
  const existing = append ? read(rows) : []
  const last = existing.at(-1)
  set(loading, true); set(error, ''); set(more, false)
  if (!append) set(rows, [])
  try {
    const result = await plugin.request('history.list', {
      ...(read(project) ? { workspaceId: read(project) } : {}),
      ...(read(status) ? { status: read(status) } : {}),
      ...(read(search).trim() ? { search: read(search).trim() } : {}),
      ...(last ? { before: { id: last.id, createdAt: last.createdAt } } : {})
    })
    if (request !== revision) return
    set(rows, [...existing, ...result.rows]); set(more, result.more)
  } catch (cause) {
    if (request === revision) { set(error, String(cause)); set(more, append) }
  } finally { if (request === revision) set(loading, false) }
}

export function HistoryBrowser({ language, workspaces, open }: { language: Language; workspaces: Workspace[]; open: (run: PipelineRun) => void }) {
  const t = (key: Message) => translate(language, key)
  return <Stack gap="xs">
    <Button size="sm" variant="ghost" onPress={() => {
      set(expanded, !read(expanded))
      if (read(expanded)) void loadPage()
      else { revision++; set(loading, false) }
    }}>{read(expanded) ? t('Close history') : t('Browse all runs')}</Button>
    {read(expanded) ? <Stack gap="sm">
      <Select label={t('History project')} value={read(project) || 'all'} options={[
        { value: 'all', label: t('All projects') }, ...workspaces.map(w => ({ value: w.id, label: w.name }))
      ]} onChange={v => { set(project, v === 'all' ? '' : v); void loadPage() }} />
      <Select label={t('History status')} value={read(status) || 'all'} options={[
        { value: 'all', label: t('All statuses') }, ...Object.entries(statuses).map(([value, key]) => ({ value, label: t(key) }))
      ]} onChange={v => { set(status, v === 'all' ? '' : v); void loadPage() }} />
      <Input label={t('Scenario name or run ID')} value={read(search)} onChange={v => { set(search, v); void loadPage() }} />
      {read(rows).map(item => <Button key={item.id} variant="outline" onPress={async () => {
        const request = ++revision
        try {
          const { run } = await plugin.request('history.open', { workspaceId: item.workspaceId, id: item.id })
          if (request === revision) { open(run); set(expanded, false); set(loading, false) }
        } catch (cause) { if (request === revision) { set(error, String(cause)); set(loading, false) } }
      }}>{item.name} · {workspaces.find(w => w.id === item.workspaceId)?.name ?? item.workspaceId} · {t(statuses[item.status])} · {item.createdAt.slice(0, 16).replace('T',' ')} · {item.id.slice(-6)}</Button>)}
      {read(error) ? <Callout title={t('Action failed')} tone="danger"><Text>{read(error)}</Text></Callout> : null}
      {read(loading) ? <Text>{t('Working…')}</Text> : !read(rows).length && !read(error) ? <Text>{t('No matching runs')}</Text> : null}
      {read(more) ? <Row><Button onPress={() => loadPage(true)}>{t('Load older runs')}</Button></Row> : null}
    </Stack> : null}
  </Stack>
}
