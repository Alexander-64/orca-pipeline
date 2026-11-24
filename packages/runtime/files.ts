import { mkdir, rename, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() }
  finally { await file.close() }
  try { await rename(temporary, path) }
  catch (error) { await unlink(temporary).catch(() => {}); throw error }
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
