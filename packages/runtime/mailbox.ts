import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson } from './files'
import { redactSecrets } from '../core/failover'
import type { UserMessage, MessageReceipt, WorkerQuestion } from '../core/types'
export type { UserMessage, MessageReceipt, WorkerQuestion } from '../core/types'

export type SessionControls = { isActive(): boolean; steer(text: string): Promise<unknown> }
export const validMessageId = (id: string) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)
export function validateUserMessage(message: UserMessage): void {
  if (!validMessageId(message.id) || (message.questionId && !validMessageId(message.questionId))) throw new Error('Invalid message identity')
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16_000) throw new Error('Message must contain 1–16000 characters')
}

async function load<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

export async function enqueueMessage(directory: string, token: string, message: UserMessage): Promise<void> {
  validateUserMessage(message)
  const file = join(directory, 'inbox', message.id + '.json')
  const previous = await load<UserMessage & { token: string }>(file)
  if (previous) {
    if (previous.text !== message.text || previous.questionId !== message.questionId || previous.token !== token) throw new Error('Message ID reused with different content')
    return
  }
  await atomicJson(file, { ...message, token })
}

export async function interactions(directory: string): Promise<{ questions: WorkerQuestion[]; messages: MessageReceipt[] }> {
  const read = async <T>(folder: string): Promise<T[]> => {
    const names = await readdir(join(directory, folder)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error })
    const values: T[] = []
    for (const name of names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).sort()) {
      const value = await load<T>(join(directory, folder, name)); if (value) values.push(value)
    }
    return values
  }
  return { questions: await read<WorkerQuestion>('questions'), messages: await read<MessageReceipt>('message-receipts') }
}

// A worker owns consumption and receipts. The supervisor only appends messages.
export class WorkerMailbox {
  private controls?: SessionControls
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, { resolve(answer: string): void; reject(error: Error): void }>()
  private polling?: Promise<void>
  private closed = false
  private timer?: NodeJS.Timeout
  private queuedWrites = Promise.resolve()
  private readonly deliveries = new Set<Promise<void>>()
  constructor(readonly directory: string, private readonly token: string, private readonly event: (event: { kind: string; text?: string }) => void) {}

  async start(): Promise<void> {
    for (const folder of ['inbox', 'questions', 'message-receipts']) await mkdir(join(this.directory, folder), { recursive: true, mode: 0o700 })
    this.timer = setInterval(() => { void this.poll().catch(error => this.event({ kind: 'mailbox.error', text: redactSecrets(String(error)) })) }, 150)
  }
  setControls(controls: SessionControls): void { this.controls = controls }
  private receipt(message: UserMessage, state: MessageReceipt['state'], error?: string): Promise<void> {
    const receipt: MessageReceipt = { id: message.id, state, at: new Date().toISOString(), ...(message.questionId ? { questionId: message.questionId } : {}), ...(error ? { error } : {}) }
    const operation = this.queuedWrites.then(async () => {
      const path = join(this.directory, 'message-receipts', message.id + '.json')
      const previous = await load<MessageReceipt>(path)
      if (previous?.state === 'delivered' && state !== 'delivered') return
      await atomicJson(path, receipt)
    })
    this.queuedWrites = operation.catch(error => this.event({ kind: 'mailbox.error', text: redactSecrets(String(error)) }))
    return operation
  }

  async poll(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.consume()
    try { await this.polling } finally { this.polling = undefined }
  }
  private async consume(): Promise<void> {
    for (const file of (await readdir(join(this.directory, 'inbox'))).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).sort()) {
      const message = await load<UserMessage & { token: string }>(join(this.directory, 'inbox', file))
      if (!message || this.seen.has(message.id) || message.token !== this.token || file !== message.id + '.json') continue
      this.seen.add(message.id)
      if (await load<MessageReceipt>(join(this.directory, 'message-receipts', message.id + '.json'))) continue
      if (this.closed) { await this.receipt(message, 'rejected', 'Worker finished before message delivery'); continue }
      let invoked = false
      try {
        // A crash after invoking a control but before its receipt must never replay the message.
        await this.receipt(message, 'unknown')
        if (message.questionId) {
          const pending = this.pending.get(message.questionId)
          if (!pending) throw new Error('Question is no longer waiting for an answer')
          const question = await load<WorkerQuestion>(join(this.directory, 'questions', message.questionId + '.json'))
          if (!question) throw new Error('Question receipt is missing')
          await atomicJson(join(this.directory, 'questions', question.id + '.json'), { ...question, state: 'answered', answeredAt: new Date().toISOString(), answerMessageId: message.id })
          await this.receipt(message, 'queued')
          this.pending.delete(question.id); pending.resolve(message.text)
          this.event({ kind: 'question.answered', text: question.id })
        } else {
          if (!this.controls?.isActive()) throw new Error('Agent is not accepting live messages')
          invoked = true
          await this.controls.steer(`[Pipeline user message ${message.id}]\n${message.text}`)
          // SDK acceptance means queued, not yet delivered to model context.
          const observed = await load<MessageReceipt>(join(this.directory, 'message-receipts', message.id + '.json'))
          if (observed?.state !== 'delivered') await this.receipt(message, 'queued')
          this.event({ kind: 'message.queued', text: message.id })
        }
      } catch (error) { await this.receipt(message, invoked ? 'unknown' : 'rejected', redactSecrets(String(error))); this.event({ kind: invoked ? 'message.unknown' : 'message.rejected', text: message.id }) }
    }
  }

  delivered(id: string): void {
    if (!validMessageId(id)) return
    this.trackDelivery(this.acknowledge(id))
  }
  private async acknowledge(id: string): Promise<void> {
    const message = await load<UserMessage & { token: string }>(join(this.directory, 'inbox', id + '.json'))
      if (!message || message.id !== id || message.token !== this.token) return
      await this.receipt(message, 'delivered'); this.event({ kind: 'message.delivered', text: id })
  }
  private trackDelivery(operation: Promise<void>): void {
    const guarded = operation.catch(error => this.event({ kind: 'mailbox.error', text: redactSecrets(String(error)) }))
    this.deliveries.add(guarded); void guarded.finally(() => this.deliveries.delete(guarded))
  }
  deliveredQuestion(toolCallId: string): void {
    this.trackDelivery(interactions(this.directory).then(async state => {
      const question = state.questions.find(question => question.toolCallId === toolCallId && question.state === 'answered')
      if (question?.answerMessageId) await this.acknowledge(question.answerMessageId)
    }))
  }

  async ask(question: string, signal: AbortSignal, toolCallId?: string): Promise<string> {
    if (this.closed || signal.aborted) throw new Error('Worker is stopping')
    const id = randomUUID()
    const value: WorkerQuestion = { id, question: redactSecrets(question), state: 'waiting', askedAt: new Date().toISOString(), toolCallId }
    let cancel!: () => void
    const answer = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      cancel = () => { this.pending.delete(id); reject(new Error('Question cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
    })
    // Install a rejection handler before the first await, including cancellation during persistence.
    void answer.catch(() => {})
    try {
      await atomicJson(join(this.directory, 'questions', id + '.json'), value)
      this.event({ kind: 'question.asked', text: `${id}: ${value.question}` })
      return await answer
    } finally {
      signal.removeEventListener('abort', cancel)
      const current = await load<WorkerQuestion>(join(this.directory, 'questions', id + '.json'))
      if (current?.state === 'waiting') await atomicJson(join(this.directory, 'questions', id + '.json'), { ...current, state: 'cancelled' })
    }
  }

  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer)
    for (const pending of this.pending.values()) pending.reject(new Error('Worker finished'))
    this.pending.clear()
    await this.poll(); await Promise.all([...this.deliveries]); await this.queuedWrites
    for (const receipt of (await interactions(this.directory)).messages) if (receipt.state === 'queued') await this.receipt({ id: receipt.id, text: '' }, 'rejected', 'Worker finished before the message entered context')
  }
}
