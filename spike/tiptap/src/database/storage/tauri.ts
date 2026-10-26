// Desktop adapter: the Rust side (src-tauri/src/database) owns the files, the redo journal, crash recovery and the SQLite index.
// This class only moves JSON across the IPC boundary and maps the Rust error prefixes onto the stable error codes.
import type { Commit, Id, Json } from '../model/types.ts'
import { DbError, type ErrorCode } from '../model/errors.ts'
import type { BatchWrite, DbStorage, LoadedDatabase, UndoGroup } from './types.ts'

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

const PREFIXES: Record<string, ErrorCode> = {
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  QUOTA: 'QUOTA',
  INVALID_FILTER: 'INVALID_FILTER',
}

/** Rust returns plain strings; `CODE:detail` becomes a DbError with that code. Anything else is an I/O error. */
export function mapRustError(e: unknown): DbError {
  const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
  const m = /^([A-Z_]+):(.*)$/s.exec(msg)
  if (m && PREFIXES[m[1]]) {
    const detail: Record<string, unknown> = {}
    if (m[1] === 'REVISION_CONFLICT') {
      const [what, expected, current] = m[2].split(':')
      const [recordKind, ...id] = what.split('/')
      Object.assign(detail, { recordKind, id: id.join('/'), expected: Number(expected), current: Number(current) })
    }
    return new DbError(PREFIXES[m[1]], m[2].slice(0, 300), detail)
  }
  return new DbError('IO', msg.slice(0, 300))
}

export class TauriStorage implements DbStorage {
  private invoke: Invoke
  constructor(invoke: Invoke) {
    this.invoke = invoke
  }
  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await this.invoke(cmd, args)) as T
    } catch (e) {
      throw mapRustError(e)
    }
  }
  recover() {
    return this.call<{ replayed: number }>('db_recover')
  }
  loadAll() {
    return this.call<LoadedDatabase>('db_load_all')
  }
  async commit(batch: BatchWrite) {
    await this.call<void>('db_commit', { batch })
  }
  async getOperation(id: Id) {
    return ((await this.call<Commit | null>('db_get_operation', { id })) ?? undefined) as Commit | undefined
  }
  async loadUndo() {
    return (await this.call<UndoGroup[]>('db_undo_load')) ?? []
  }
  async saveUndo(groups: UndoGroup[]) {
    await this.call<void>('db_undo_save', { groups })
  }
  history(kind: string, id: Id) {
    return this.call<{ revision: number; body: Json }[]>('db_history', { kind, id })
  }
  async rebuildIndex() {
    await this.call<number>('db_index_rebuild')
  }
  /** Indexed candidate ids for one simple predicate (the engine still applies the full filter to them). */
  candidates(source: Id, property: Id, op: string, operand: Json) {
    return this.call<Id[]>('db_index_candidates', { source, property, op, operand })
  }
  runtime() {
    return {
      get: (key: string) => this.call<Json | null>('db_runtime_get', { key }).then((v) => v ?? undefined),
      set: (key: string, value: Json) => this.call<void>('db_runtime_set', { key, value }),
      delete: (key: string) => this.call<void>('db_runtime_delete', { key }),
      keys: (prefix: string) => this.call<string[]>('db_runtime_keys', { prefix }),
    }
  }
}
