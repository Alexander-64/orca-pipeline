import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactValue } from '../core/failover'
import type { HistoryQuery, RunSummary } from '../core/types'
import { processExited } from './process-lifetime'

export type StoredEvent = { seq: number; at: string; kind: string; data: unknown }
export const stateVersion = 4
export type SupervisorOwner = { pid: number; token: string; bootId?: string }

export class RunStore {
  private readonly db: DatabaseSync

  constructor(readonly path: string, readonly readOnly = false) {
    if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path, { readOnly })
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.function('pipeline_casefold', { deterministic: true }, value => String(value).toLowerCase())
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get()
    const previousVersion = existing ? this.db.prepare('SELECT version FROM metadata').get()?.version : undefined
    if (existing && ![1, 2, 3, stateVersion].includes(Number(previousVersion))) { this.db.close(); throw new Error(`Unsupported state version: ${previousVersion}`) }
    if (!readOnly) {
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL);
        INSERT INTO metadata SELECT 4 WHERE NOT EXISTS(SELECT 1 FROM metadata);
        CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_run_history ON records(
          json_extract(value,'$.workspacePath'),json_extract(value,'$.createdAt') DESC,substr(key,5) DESC
        ) WHERE key >= 'run:' AND key < 'run;';
        CREATE TABLE IF NOT EXISTS event_receipts(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);`)
    }
    if (previousVersion !== undefined && previousVersion !== stateVersion && !readOnly) {
      // The record format remains JSON. Preserve every old snapshot/receipt and
      // event; the version fence prevents older schedulers ignoring v2 fields.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const current = this.db.prepare('SELECT version FROM metadata').get()?.version
        if (![1, 2, 3, stateVersion].includes(Number(current))) throw new Error('State version changed during migration')
        if (current !== stateVersion) {
          this.db.prepare('UPDATE metadata SET version=?').run(stateVersion)
          this.event('state.migrated', { from: current, to: stateVersion, recordsPreserved: true })
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
  }

  claimSupervisor(owner: SupervisorOwner, legacy?: SupervisorOwner): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get<SupervisorOwner>('runtime:supervisor-owner')
      for (const previous of [current, legacy]) if (previous && previous.token !== owner.token && !processExited(previous.pid, previous.bootId)) throw new Error('Supervisor owner is still alive or its exit is unverified')
      this.db.prepare('INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('runtime:supervisor-owner', JSON.stringify(owner))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  releaseSupervisor(token: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.get<SupervisorOwner>('runtime:supervisor-owner')?.token === token) this.db.prepare('DELETE FROM records WHERE key=?').run('runtime:supervisor-owner')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }

  runPage(path: string, query: HistoryQuery, limit: number): Omit<RunSummary, 'controller' | 'workspaceId'>[] {
    // Cursor includes the ID because independent runs can share a creation timestamp.
    const rows = this.db.prepare(`
      SELECT substr(key,5) AS id, json_extract(value,'$.createdAt') AS createdAt,
             json_extract(value,'$.scenario.name') AS name, json_extract(value,'$.status') AS status
      FROM records WHERE key >= 'run:' AND key < 'run;' AND json_extract(value,'$.workspacePath') = ?
        AND (? = '' OR status = ?) AND (? = '' OR instr(pipeline_casefold(name || ' ' || id), pipeline_casefold(?)) > 0)
        AND (? = '' OR (createdAt,id) < (?,?))
      ORDER BY createdAt DESC, id DESC LIMIT ?
    `).all(path, query.status ?? '', query.status ?? '', query.search ?? '', query.search ?? '',
      query.before?.createdAt ?? '', query.before?.createdAt ?? '', query.before?.id ?? '', limit)
    return rows.map(row => ({ id: String(row.id), createdAt: String(row.createdAt), name: String(row.name), status: row.status as RunSummary['status'] }))
  }

  list<T>(prefix: string): T[] {
    return this.db.prepare('SELECT value FROM records WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length, prefix)
      .map(row => JSON.parse(String(row.value)) as T)
  }

  // Snapshot and event are committed together. Only the supervisor writes state.
  put(key: string, value: unknown, kind = 'state.changed', data: unknown = { key }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
      this.db.prepare('INSERT INTO events(at,kind,data) VALUES(?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(redactValue(data)))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  event(kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(at,kind,data) VALUES(?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(redactValue(data)))
  }

  eventOnce(id: string, kind: string, data: unknown): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO event_receipts(id) VALUES(?)').run(id)
      if (inserted.changes) this.event(kind, data)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  events(after = 0, limit = 200): StoredEvent[] {
    return this.db.prepare('SELECT seq,at,kind,data FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, Math.max(1, Math.min(1000, limit)))
      .map(row => ({ seq: Number(row.seq), at: String(row.at), kind: String(row.kind), data: JSON.parse(String(row.data)) }))
  }

  close(): void { this.db.close() }
}
