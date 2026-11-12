export type MutationStatus = 'pending' | 'completed' | 'failed'

export type MutationRecord = {
  requestId: string
  args: string[]
  status: MutationStatus
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

type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export class StorageMutationJournal implements MutationJournal {
  constructor(private readonly storage: Storage, private readonly key = 'pipeline.mutations.v1') {}

  async put(record: MutationRecord): Promise<void> {
    const records = await this.list()
    const index = records.findIndex((candidate) => candidate.requestId === record.requestId)
    if (index === -1) records.push(record)
    else records[index] = record
    await this.storage.set(this.key, records)
  }

  async list(): Promise<MutationRecord[]> {
    const value = await this.storage.get(this.key)
    return Array.isArray(value) ? value as MutationRecord[] : []
  }
}
