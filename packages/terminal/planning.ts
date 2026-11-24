import { mkdir, writeFile, link, unlink } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseScenario } from '../core/scenario'
import { runPi } from '../pi-adapter/session'
import { RunStore } from '../runtime/store'
import { createBackend } from '../runtime/factory'
import type { RuntimeConfig } from '../runtime/config'

export async function createPlan(project: string, config: RuntimeConfig, goal: string, signal: AbortSignal, onEvent: (event: { kind: string; tool?: string }) => void, outputFile?: string) {
  if (!goal.trim()) throw new Error('Describe the task')
  const planner = Object.values(config.executors).find(executor => executor.kind === 'pi')
  if (!planner) throw new Error('Configure a Pi planner executor')
  const response = await runPi({
    cwd: project, prompt: `Inspect the project README and structure. User goal: ${goal}\nCreate a useful small DAG and submit the COMPLETE YAML through propose_plan. Required schema: name, objective, commandPolicy: {readOnly: true}, steps: [{id, title, spec, agent, needs: [], placement: {host: local, worktree: current}, acceptance: [pwd], maxAttempts: 1, maxRepairs: 0}]. Use only these configured executors: ${Object.keys(config.executors).join(', ')}. An independent review must be a separate step with its own fresh session. Choose only real project checks; for a read-only audit use pwd and ls. Each spec must be self-contained. No source edits, network requests or external messages. Do not use reviewAgent shorthand. If the goal needs result-based branches, use version: 2. A producer declares flat outputSchema: {decision: {type: string, enum: [improve, pass]}}; each conditional successor declares needs: [producer-id] and when: {step: producer-id, field: decision, op: eq, value: improve}. Supported types string/number/boolean, optional fields required:false, operators eq/ne/gt/gte/lt/lte/exists. Conditions may group under all: [...] or any: [...]. A final join waiting for alternative branches must use join: all_settled; default all_success skips when a predecessor failed or was skipped. Conditions reference only declared fields of graph predecessors. In each producer spec require a typed result and a concise report. The runtime supplies submit_result for Pi and a versioned JSON envelope for text-only executors; keep the task intent portable across executors. A failed acceptance always blocks successful routing. Keep v1 for simple flows without data conditions. Keep specs concise. Call propose_plan to validate and repair any errors before finishing.`,
    sessionDir: join(project, '.agent-pipeline', 'planner', randomUUID()), readOnly: true, provider: planner.provider, model: planner.model,
    signal, plan: true, onEvent
  })
  const source = response.planSource!
  const scenario = parseScenario(source)
  const memory = new RunStore(':memory:')
  try { await createBackend(memory, project, config).preflightScenario(scenario) } finally { memory.close() }
  const file = resolve(project, outputFile ?? join('.agent-pipeline', 'plans', `${randomUUID()}.pipeline.yaml`))
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, source, { flag: 'wx', mode: 0o600 })
  try { await link(temporary, file) } finally { await unlink(temporary) }
  return { file, source, scenario, sessionFile: response.sessionFile }
}
