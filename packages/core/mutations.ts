import { ChunkedJsonStorage, type JsonStorage } from './chunked-storage'

export type MutationStatus = 'pending' | 'completed' | 'failed'

export type MutationRecord = {
  requestId: string
  args: string[]
  status: MutationStatus
  launch?: { runId: string; taskId: string; retryOf?: string }
  result?: Record<string, unknown>
  error?: string
}

export interface MutationJournal {
  put(record: MutationRecord): Promise<void>
  list(): Promise<MutationRecord[]>
}

export class MemoryMutationJournal implements MutationJournal {
  private readonly records = new Map<string, MutationRecord>()

  async put(record: MutationRecord): Promise<void> {
    this.records.set(record.requestId, structuredClone(record))
  }

  async list(): Promise<MutationRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record))
  }
}

export class StorageMutationJournal implements MutationJournal {
  private writes: Promise<void> = Promise.resolve()
  private readonly storage: ChunkedJsonStorage
  constructor(storage: JsonStorage, private readonly key = 'pipeline.mutations.v1') {
    this.storage = new ChunkedJsonStorage(storage)
  }

  async put(record: MutationRecord): Promise<void> {
    const operation = this.writes.then(async () => {
      const value = await this.storage.get(this.key)
      const records: MutationRecord[] = Array.isArray(value) ? value : []
      const index = records.findIndex((candidate) => candidate.requestId === record.requestId)
      if (index === -1) records.push(record)
      else records[index] = record
      await this.storage.set(this.key, records)
    })
    this.writes = operation.catch(() => {})
    await operation
  }

  async list(): Promise<MutationRecord[]> {
    await this.writes
    const value = await this.storage.get(this.key)
    return Array.isArray(value) ? value as MutationRecord[] : []
  }
}
