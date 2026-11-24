import { randomUUID } from 'node:crypto'

export type JsonStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete?(key: string): Promise<void>
}

type Manifest = { format: 'pipeline.chunks.v1'; generation: string; count: number }
const chunkLength = 32_000
function manifest(value: unknown): value is Manifest {
  const v = value as Partial<Manifest> | null
  return !!v && v.format === 'pipeline.chunks.v1' && typeof v.generation === 'string' && Number.isSafeInteger(v.count) && v.count! > 0
}
const chunkKey = (key: string, value: Manifest, index: number) => `${key}.${value.generation}.${index}`

// Orca limits each JSON value to 256 KiB. Keep existing inline values readable,
// and publish a large snapshot only after every immutable chunk is durable.
export class ChunkedJsonStorage {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly storage: JsonStorage) {}

  get(key: string): Promise<unknown> {
    const operation = this.writes.then(() => this.read(key))
    this.writes = operation.then(() => {}, () => {})
    return operation
  }

  private async read(key: string): Promise<unknown> {
    const value = await this.storage.get(key)
    if (!manifest(value)) return value
    const parts: string[] = []
    for (let index = 0; index < value.count; index++) {
      const part = await this.storage.get(chunkKey(key, value, index))
      if (typeof part !== 'string') throw new Error(`Incomplete stored snapshot: ${key}, chunk ${index}`)
      parts.push(part)
    }
    return JSON.parse(parts.join(''))
  }

  set(key: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value)
    const operation = this.writes.then(async () => {
      const previous = await this.storage.get(key)
      let next: Manifest | undefined
      let written = 0
      try {
        if (Buffer.byteLength(encoded, 'utf8') <= 192_000) {
          await this.storage.set(key, JSON.parse(encoded))
        } else {
          next = { format: 'pipeline.chunks.v1', generation: randomUUID(), count: Math.ceil(encoded.length / chunkLength) }
          for (let index = 0; index < next.count; index++) {
            // At most six JSON bytes per UTF-16 code unit, including escaping.
            await this.storage.set(chunkKey(key, next, index), encoded.slice(index * chunkLength, (index + 1) * chunkLength))
            written++
          }
          await this.storage.set(key, next)
        }
      } catch (error) {
        if (next) await this.cleanup(key, { ...next, count: written })
        throw error
      }
      if (manifest(previous)) await this.cleanup(key, previous)
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  private async cleanup(key: string, value: Manifest): Promise<void> {
    for (let index = 0; index < value.count; index++) {
      // Cleanup cannot turn a committed write into an apparent failed write.
      await this.storage.delete?.(chunkKey(key, value, index)).catch(() => {})
    }
  }
}
