import { Badge, Button, Callout, Card, CodeView, Collapsible, EmptyState, Heading, List, ListItem, Row, Stack, Text } from 'orca'
import type { PipelineRun } from './types'
import { translate, type Language, type Message } from './i18n'
import { diagnosticText, renderDiagnostic } from './diagnostics'
import { STATUS } from './step-status'

export function RunResult({ run, projectName, language, openStep, openAttempt }: {
  run?: PipelineRun; projectName: string; language: Language
  openStep: (step: string) => void; openAttempt: (dispatch: string) => void
}) {
  const t = (key: Message, ...values: unknown[]) => translate(language, key, ...values)
  const diagnosis = (raw?: string) => diagnosticText(language, raw)
  if (!run) return <EmptyState icon="file-text" title={t("Select a saved run")} description={t("Results appear after launch. Use the run selector at the top.")} />
  const tasks = run.scenario.steps.flatMap(step => run.tasks[step.id] ? [{ step, task: run.tasks[step.id] }] : [])
  const sinks = tasks.filter(({ step }) => !run.scenario.steps.some(next => next.needs.includes(step.id)))
  return <Stack gap="md">
    <Heading level={2}>{t("Result · {0}", run.scenario.name)}</Heading>
    <Badge tone={run.status === 'done' ? 'success' : run.status === 'failed' || run.status === 'cancelled' ? 'danger' : 'accent'}>{run.status === 'done' ? t("Run completed") : run.status === 'failed' ? t("Run failed") : run.status === 'cancelled' ? t("Run cancelled") : t("Partial results")}</Badge>
    <Text muted size="sm">{t("Project: {0} · Run owner: {1}", projectName, run.controller === 'terminal' ? t("Terminal") : 'Orca')}</Text>
    <Text>{run.scenario.objective}</Text>
    {tasks.filter(({ task }) => task.status === 'failed').map(({ step, task }) => {
      const attempt = task.attempts.at(-1)
      const check = attempt?.checks?.find(item => item.exitCode !== null && item.exitCode !== 0) ?? attempt?.checks?.find(item => item.exitCode === null)
      return <Callout key={step.id} tone="danger" title={t("Failed step: {0}", step.title)}>
        <Stack gap="xs">
          <Text>{check ? renderDiagnostic(language, { id: 'attempt.checkFailed', ...check }) : diagnosis(task.error) || t("No check result recorded")}</Text>
          {attempt ? <Collapsible title={t("Attempt {0} · {1}", task.attempts.length, attempt.agent)}>
            <Text muted size="xs">{attempt.dispatchId}</Text>
            {attempt.output ? <CodeView code={attempt.output} wrap maxHeight="md" /> : <Text>{t("No output yet.")}</Text>}
            {run.controller !== 'terminal' ? <Button onPress={() => openAttempt(attempt.dispatchId)}>{t("Open agent session")}</Button> : null}
          </Collapsible> : null}
          <Button size="sm" onPress={() => openStep(step.id)}>{t("Inspect step")}</Button>
        </Stack>
      </Callout>
    })}
    <Row gap="sm" wrap>
      <Badge tone="success">{t("Finished: {0}", tasks.filter(({ task }) => task.status === 'done').length)}</Badge>
      <Badge tone="danger">{t("Errors: {0}", tasks.filter(({ task }) => task.status === 'failed').length)}</Badge>
      <Badge>{t("Remaining: {0}", tasks.filter(({ task }) => !['done', 'failed'].includes(task.status)).length)}</Badge>
    </Row>
    <Text muted size="sm">{t("Created: {0} · Updated: {1}", run.createdAt, run.updatedAt)}</Text>
    {run.error ? <Callout tone="danger" title={t("Reason for stopping")}><Text>{diagnosis(run.error)}</Text></Callout> : null}
    {run.pr ? <Callout title={`Pull request · ${run.pr.status}`}><Text>{run.pr.url}</Text></Callout> : null}
    <Heading level={3}>{t("Final steps")}</Heading>
    <Text muted size="sm">{t("Results from the last step of each branch. An unfinished run can have partial results.")}</Text>
    {sinks.map(({ step, task }) => <Card title={step.title}>
      <Stack gap="sm">
        <Badge tone={STATUS[task.status].tone}>{t(STATUS[task.status].label)}</Badge>
        {task.attempts.at(-1)?.output ? <CodeView code={task.attempts.at(-1)!.output!} wrap maxHeight="lg" /> : <Text muted>{t("No result for this step yet.")}</Text>}
        {task.error ? <Text tone="danger">{diagnosis(task.error)}</Text> : null}
      </Stack>
    </Card>)}
    <Heading level={3}>{t("All step results")}</Heading>
    {tasks.map(({ step, task }) => <Collapsible key={`${run.id}:${step.id}`} title={`${step.title} · ${t(STATUS[task.status].label)}`}>
      <Stack gap="sm">
        {task.skipReason ? <Text>{task.skipReason}</Text> : null}
        {task.error ? <Callout tone="danger" title={t("Step error")}><Text>{diagnosis(task.error)}</Text></Callout> : null}
        {task.data ? <CodeView code={JSON.stringify(task.data, null, 2)} language="json" wrap /> : null}
        {task.attempts.at(-1)?.output ? <CodeView code={task.attempts.at(-1)!.output!} wrap maxHeight="lg" /> : <Text muted>{t("No output yet.")}</Text>}
        {task.attempts.at(-1)?.checks?.length ? <List>{task.attempts.at(-1)!.checks!.map(check => <ListItem title={check.command} description={check.exitCode === null ? t("Check outcome unknown") : t("Exit code: {0}", check.exitCode)} />)}</List> : null}
        {task.attempts.at(-1)?.filesModified?.length ? <List>{task.attempts.at(-1)!.filesModified!.map(file => <ListItem title={file} icon="file" />)}</List> : null}
        {task.attempts.at(-1)?.artifactPath ? <Text muted size="sm">{t("Artifact: {0}", task.attempts.at(-1)!.artifactPath)}</Text> : null}
        {task.attempts.at(-1)?.reportPath ? <Text muted size="sm">{t("Report: {0}", task.attempts.at(-1)!.reportPath)}</Text> : null}
        <Button size="sm" variant="outline" onPress={() => openStep(step.id)}>{t("Open step")}</Button>
      </Stack>
    </Collapsible>)}
  </Stack>
}
