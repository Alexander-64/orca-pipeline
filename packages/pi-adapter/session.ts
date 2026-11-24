import { realpath, open, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname, sep } from 'node:path'
import { Type, type TSchema } from 'typebox'
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { redactSecrets, redactValue } from '../core/failover'
import { parseScenario, serializeScenario } from '../core/scenario'
import { validateResult } from '../core/results'
import { validateReview } from '../core/review'
import type { OutputSchema, StructuredData, ReviewResult } from '../core/types'

export type PiRequest = {
  cwd: string; prompt: string; sessionDir: string; readOnly: boolean
  provider?: string; model?: string; signal: AbortSignal
  onEvent: (event: { kind: string; text?: string; tool?: string }) => void
  plan?: boolean
  onReady?: (controls: { isActive(): boolean; steer(text: string): Promise<unknown> }) => void
  onQuestion?: (question: string, signal: AbortSignal, toolCallId: string) => Promise<string>
  onQuestionDelivered?: (toolCallId: string) => void
  onMessageDelivered?: (id: string) => void
  onSession?: (file: string) => Promise<void>
  resumeSessionFile?: string
  outputSchema?: OutputSchema
  evidence?: boolean
  console?: {
    inspect(): Promise<unknown>; status(): Promise<unknown>
    plan(source: string): Promise<unknown>; update(source: string): Promise<unknown>
    control(action: 'run' | 'pause' | 'resume' | 'stop' | 'retry' | 'reconcile', operationId: string): Promise<unknown>
  }
}

export async function confinedPath(cwd: string, input: string, write = false): Promise<string> {
  const root = await realpath(cwd)
  const target = resolve(root, input)
  const inside = (path: string) => {
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('Path outside project')
    if (rel.split(sep).some(part => ['.git', '.agent-pipeline', '.orca', '.pi', '.codex', '.cline'].includes(part) || part === '.env' || part.startsWith('.env.'))) throw new Error('Protected project path')
    return path
  }
  inside(target)
  try { return inside(await realpath(target)) }
  catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Parent must exist and be inside the root; never follow an unchecked symlink.
    inside(await realpath(dirname(target)))
    return target
  }
}

const content = (text: string) => ({ content: [{ type: 'text' as const, text: redactSecrets(text) }], details: {} })
const typedTool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition => definition as ToolDefinition

export async function resolvePiModel(cwd: string, provider?: string, modelId?: string) {
  const runtime = await ModelRuntime.create()
  const defaults = SettingsManager.create(cwd)
  provider ??= defaults.getDefaultProvider()
  modelId ??= provider === defaults.getDefaultProvider() ? defaults.getDefaultModel() : undefined
  const models = await runtime.getAvailable(provider)
  const model = modelId ? models.find(model => model.id === modelId) : models[0]
  if (!model) throw new Error(`No configured Pi model for ${provider ?? 'default'}/${modelId ?? 'default'}. Configure an existing provider or use a CLI executor.`)
  return { runtime, model }
}

export async function runPi(request: PiRequest): Promise<{ text: string; sessionFile?: string; planSource?: string; data?: StructuredData; review?: ReviewResult; filesModified?: string[]; uncertainFiles: string[] }> {
  const { runtime, model } = await resolvePiModel(request.cwd, request.provider, request.model)
  let planSource: string | undefined
  let planSubmissions = 0, planLimitExceeded = false
  let data: StructuredData | undefined
  let review: ReviewResult | undefined
  const written = new Set<string>(), uncertain = new Set<string>()
  let completeFileHistory = true
  const tools: ToolDefinition[] = [typedTool({
    name: 'read_file', label: 'Read project file', description: 'Read a UTF-8 file inside the project. Use offset and limit for large files.',
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
    async execute(_id, args) {
      const path = await confinedPath(request.cwd, args.path)
      const file = await open(path, 'r')
      const buffer = Buffer.alloc(2_000_001)
      let bytes: Buffer
      try {
        if (!(await file.stat()).isFile()) throw new Error('Expected regular file')
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        bytes = buffer.subarray(0, bytesRead)
      } finally { await file.close() }
      if (bytes.length > 2_000_000 || bytes.includes(0)) throw new Error('File is binary or too large')
      return content(bytes.toString('utf8').split('\n').slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)).join('\n').slice(0, 40_000))
    }
  }), typedTool({
    name: 'list_files', label: 'List project directory', description: 'List one directory inside the project.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      const path = await confinedPath(request.cwd, args.path ?? '.')
      return content((await readdir(path, { withFileTypes: true })).filter(entry => !['.git', 'node_modules', '.env'].includes(entry.name) && !entry.name.startsWith('.env.')).slice(0, 300).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).join('\n'))
    }
  })]
  if (request.onQuestion) tools.push(typedTool({
    name: 'ask_user', label: 'Ask the user', description: 'Ask a necessary question and wait for the user answer. This does not approve workflow gates.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(id, args, signal) { return content(await request.onQuestion!(args.question, signal ?? request.signal, id)) }
  }))
  if (request.outputSchema) tools.push(typedTool({
    name: 'submit_result', label: 'Submit structured result', description: 'Submit the complete typed result. Required schema: ' + JSON.stringify(request.outputSchema) + '. Correct validation errors before finishing.',
    parameters: Type.Object({ data: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])) }),
    async execute(_id, args) { data = validateResult(request.outputSchema!, args.data); return content(JSON.stringify({ validated: true, data })) }
  }))
  if (request.evidence) tools.push(typedTool({
    name: 'submit_review', label: 'Submit independent review', description: 'Record SHIP, FIX-FIRST or BLOCKED with concrete evidence. This does not approve user gates or repair files. Correct invalid submissions before finishing.',
    parameters: Type.Object({ verdict: Type.Union([Type.Literal('SHIP'), Type.Literal('FIX-FIRST'), Type.Literal('BLOCKED')]), findings: Type.String({ minLength: 1, maxLength: 12_000 }) }),
    async execute(_id, args) { review = validateReview({ version: 1, ...args }); return content(JSON.stringify({ review })) }
  }))
  if (request.console) {
    for (const name of ['inspect', 'status'] as const) tools.push(typedTool({
      name, label: name, description: name === 'inspect' ? 'Inspect the selected project, draft and configured executor routes.' : 'Read fresh runtime state, reports and pending approvals. This never changes a run.',
      parameters: Type.Object({}),
      async execute() { return content(JSON.stringify(redactValue(await request.console![name]()))) }
    }))
    for (const name of ['plan', 'update'] as const) tools.push(typedTool({
      name, label: name, description: name === 'plan' ? 'Validate and save a complete new YAML draft. Does not start workers.' : 'Validate and save a new revision of the selected draft. Does not change an active run. Input is COMPLETE YAML.',
      parameters: Type.Object({ source: Type.String({ maxLength: 200_000 }) }),
      async execute(_id, args) {
        if (++planSubmissions > 3) { planLimitExceeded = true; void session.abort(); throw new Error('Planner validation budget exhausted (3 submissions)') }
        return content(JSON.stringify(redactValue(await request.console![name](args.source))))
      }
    }))
    tools.push(typedTool({
      name: 'control', label: 'Control selected pipeline', description: 'Only on a direct user request: run the validated draft, or pause/resume/stop/retry/reconcile the selected run through its supervisor. Cannot approve gates, assign agents, publish, or send external messages. Inspect status first. An unknown outcome must be reconciled, never bypassed with a new start.',
      parameters: Type.Object({ action: Type.Union(['run', 'pause', 'resume', 'stop', 'retry', 'reconcile'].map(action => Type.Literal(action))) }),
      async execute(id, args) { return content(JSON.stringify(redactValue(await request.console!.control(args.action as 'run' | 'pause' | 'resume' | 'stop' | 'retry' | 'reconcile', id)))) }
    }))
  }
  if (request.plan) tools.push(typedTool({
    name: 'propose_plan', label: 'Validate pipeline plan', description: 'Submit the complete YAML scenario. Validation errors must be corrected before finishing.',
    parameters: Type.Object({ source: Type.String({ maxLength: 200_000 }) }),
    async execute(_id, args) {
      if (++planSubmissions > 3) {
        planLimitExceeded = true
        request.onEvent({ kind: 'planner.validation-limit' })
        void session.abort()
        throw new Error('Planner validation budget exhausted (3 submissions)')
      }
      const scenario = parseScenario(args.source, { expandEvidence: false })
      planSource = serializeScenario(scenario)
      return content('Plan accepted: ' + scenario.steps.length + ' steps')
    }
  }))
  if (!request.readOnly && !request.evidence) tools.push(typedTool({
    name: 'write_file', label: 'Write project file', description: 'Write a UTF-8 file inside an existing project directory.',
    parameters: Type.Object({ path: Type.String(), text: Type.String({ maxLength: 200_000 }) }),
    async execute(_id, args) {
      const path = await confinedPath(request.cwd, args.path, true), file = relative(await realpath(request.cwd), path)
      uncertain.add(file); await writeFile(path, args.text); written.add(file); uncertain.delete(file)
      return { ...content('Saved ' + args.path), details: { pipelineFile: file } }
    }
  }))
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => request.console
      ? 'You are the interactive Agent Pipeline console assistant. Inspect the project and current draft/runtime with your tools. Use plan for a new scenario, update for a requested draft change, status for fresh observations, and control ONLY for a direct user request to run/pause/resume/stop/retry/reconcile. Planning is not permission to start. Never approve a user gate; explain the explicit approve command instead. Never invent execution, completion, checks, agent identities or delivery. Existing active runs use immutable snapshots; draft changes affect the next run. Respect errors and unknown effects. Do not edit source files or use network/external messaging. Return a concise answer in the user language under 150 words.'
      : 'You are an Agent Pipeline executor. Follow the assigned task and project instructions. Use only the provided tools. Return a complete, concise report under 1400 words with evidence and limitations. Do not claim checks were executed: the runtime runs acceptance separately.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {}
  }
  await mkdir(request.sessionDir, { recursive: true, mode: 0o700 })
  const manager = request.resumeSessionFile
    ? SessionManager.open(request.resumeSessionFile, request.sessionDir, request.cwd)
    : SessionManager.create(request.cwd, request.sessionDir)
  const { session } = await createAgentSession({
    cwd: request.cwd, modelRuntime: runtime, model, thinkingLevel: 'off', tools: tools.map(tool => tool.name), customTools: tools,
    resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 } })
  })
  let settled = false, aborted = false
  const cancel = () => { void session.abort() }
  request.signal.addEventListener('abort', cancel, { once: true })
  session.subscribe(event => {
    if (event.type === 'agent_start') request.onEvent({ kind: 'agent.started' })
    if (event.type === 'agent_settled') { settled = true; aborted = event.aborted }
    if (event.type === 'tool_execution_start') request.onEvent({ kind: 'tool.started', tool: event.toolName })
    if (event.type === 'tool_execution_end') request.onEvent({ kind: 'tool.finished', tool: event.toolName })
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') request.onEvent({ kind: 'text.delta', text: event.assistantMessageEvent.delta })
    if (event.type === 'message_start' && event.message.role === 'user') {
      const text = typeof event.message.content === 'string' ? event.message.content : event.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      const id = /^\[Pipeline user message ([a-zA-Z0-9_-]+)\]/.exec(text)?.[1]
      if (id) request.onMessageDelivered?.(id)
    }
    if (event.type === 'message_start' && event.message.role === 'toolResult' && event.message.toolName === 'ask_user') request.onQuestionDelivered?.(event.message.toolCallId)
  })
  try {
    if (request.resumeSessionFile) for (const message of session.messages) if (message.role === 'toolResult' && message.toolName === 'write_file' && !message.isError) {
      const details = 'details' in message && message.details && typeof message.details === 'object' ? message.details as Record<string, unknown> : {}
      if (typeof details.pipelineFile === 'string') written.add(details.pipelineFile)
      else completeFileHistory = false
    }
    if (request.resumeSessionFile && request.evidence) for (const message of session.messages) if (message.role === 'toolResult' && message.toolName === 'submit_review' && !message.isError) {
      try { review = validateReview(JSON.parse(message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).review) } catch { /* Require a fresh verdict after an incomplete receipt. */ }
    }
    if (request.resumeSessionFile && request.outputSchema) for (const message of session.messages) if (message.role === 'toolResult' && message.toolName === 'submit_result' && !message.isError) {
      try {
        const text = message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
        data = validateResult(request.outputSchema, JSON.parse(text).data)
      } catch { /* An incomplete receipt requires a fresh submit_result. */ }
    }
    if (request.resumeSessionFile) for (const message of session.messages) if (message.role === 'toolResult' && message.toolName === 'ask_user') request.onQuestionDelivered?.(message.toolCallId)
    if (request.resumeSessionFile) for (const message of session.messages) if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      const id = /^\[Pipeline user message ([a-zA-Z0-9_-]+)\]/.exec(text)?.[1]
      if (id) request.onMessageDelivered?.(id)
    }
    const file = manager.getSessionFile()
    if (file) await request.onSession?.(file)
    request.onReady?.({ isActive: () => session.isStreaming, steer: async text => {
      if (!session.isStreaming) throw new Error('Agent has already settled; message was not sent')
      return session.steer(text)
    } })
    if (request.signal.aborted) throw new Error('Cancelled before start')
    await session.prompt(request.prompt)
    if (planLimitExceeded) throw new Error('Planner validation budget exhausted (3 submissions)')
    let last = session.messages.filter(message => message.role === 'assistant').at(-1)
    // Continue a truncated answer once in the SAME session. This is not failover or a new attempt.
    if (last?.stopReason === 'length' && !request.signal.aborted) {
      request.onEvent({ kind: 'answer.continuation', text: 'Output limit reached; requesting one complete concise report in the same session' })
      settled = false
      await session.prompt('The previous answer was truncated by the output limit. Return a COMPLETE concise replacement report in at most 1000 words. Preserve key evidence, findings and limitations. Do not repeat file exploration. If planning, keep the accepted propose_plan unchanged.')
      last = session.messages.filter(message => message.role === 'assistant').at(-1)
    }
    if (!settled || aborted || request.signal.aborted || !last || last.stopReason !== 'stop') throw Object.assign(new Error(last?.errorMessage || `Pi did not finish successfully (${last?.stopReason ?? 'no result'})`), { partialText: session.getLastAssistantText() })
    const text = session.getLastAssistantText()
    if (!text?.trim()) throw new Error('Pi returned an empty result')
    if (request.plan && !planSource) throw new Error('Planner did not submit a valid scenario via propose_plan')
    if (request.outputSchema && !data) throw Object.assign(new Error('Executor did not submit valid data via submit_result'), { failurePhase: 'validation' })
    if (request.evidence && !review) throw Object.assign(new Error('Reviewer did not submit a valid verdict via submit_review'), { failurePhase: 'validation' })
    return { text: redactSecrets(text), sessionFile: manager.getSessionFile(), planSource, data, review, filesModified: completeFileHistory ? [...written].sort() : undefined, uncertainFiles: [...uncertain].sort() }
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { filesModified: completeFileHistory ? [...written].sort() : undefined, uncertainFiles: [...uncertain].sort() })
  } finally { request.signal.removeEventListener('abort', cancel); session.dispose(); await runtime.settleCredentialWrites() }
}
