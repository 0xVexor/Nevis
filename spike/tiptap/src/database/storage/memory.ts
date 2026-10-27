// In-memory DbStorage with a real redo journal, used by tests and as the reference behaviour for the IndexedDB / Vault adapters.
// Failure injection (`crashAt`) lets tests stop the process between journal commit, record writes and index update (F33/F34).
import type { Commit, Id, Json, PageLike, RecordKind } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import type { AnyRecord } from '../state.ts'
import type { BatchWrite, DbStorage, LoadedDatabase, UndoGroup } from './types.ts'
import { canonicalDocumentValue } from '../../documents/revision.ts'
import { MemoryPages } from '../state.ts'

export type CrashPoint = 'before_journal_commit' | 'after_journal_commit' | 'between_writes' | 'before_index'

type Journal = { batch: BatchWrite; committed: boolean; applied: boolean }

export class CrashError extends Error {
  point: CrashPoint
  constructor(point: CrashPoint) {
    super(`simulated crash at ${point}`)
    this.point = point
  }
}

export class MemoryStorage implements DbStorage {
  files = new Map<string, AnyRecord>() // `${kind}/${id}`
  pages: MemoryPages
  journals = new Map<Id, Journal>()
  ops = new Map<Id, Commit>()
  undo: UndoGroup[] = []
  hist = new Map<string, { revision: number; body: Json }[]>()
  indexGeneration = 0
  crashAt: CrashPoint | null = null
  failWith: Error | null = null
  keepHistory = 50

  constructor(pages = new MemoryPages()) {
    this.pages = pages
  }

  private key = (kind: string, id: Id) => `${kind}/${id}`

  async recover() {
    let replayed = 0
    for (const j of this.journals.values()) {
      if (!j.committed || j.applied) continue
      this.verifyBases(j.batch, true)
      this.apply(j.batch)
      j.applied = true
      replayed++
    }
    // an uncommitted journal has no visible effect
    for (const [id, j] of [...this.journals]) if (!j.committed) this.journals.delete(id)
    return { replayed }
  }

  /** files must match either the expected old state or the post-image; anything else fails closed. */
  private verifyBases(b: BatchWrite, recovering: boolean) {
    const check = (cur: number, base: number, post: number | null, what: string) => {
      if (cur === base) return
      if (recovering && post !== null && cur === post) return // already applied
      fail('RECOVERY_REQUIRED', `${what} does not match the journal`, { expected: base, actual: cur })
    }
    for (const w of b.records) check(this.files.get(this.key(w.kind, w.id))?.revision ?? 0, w.baseRevision, w.after?.revision ?? null, `${w.kind}/${w.id}`)
    for (const w of b.pages) {
      if (Object.hasOwn(w, 'before')) {
        const actual = canonicalDocumentValue(this.pages.get(w.id) ?? null)
        if (actual === canonicalDocumentValue(w.before) || (recovering && actual === canonicalDocumentValue(w.after))) continue
        fail(recovering ? 'RECOVERY_REQUIRED' : 'REVISION_CONFLICT', `page/${w.id} content changed`)
      }
      check(this.pages.get(w.id)?.recordMeta?.revision ?? 0, w.baseRevision, w.after?.recordMeta?.revision ?? null, `page/${w.id}`)
    }
  }

  private apply(b: BatchWrite) {
    let n = 0
    for (const w of b.records) {
      if (this.crashAt === 'between_writes' && n++ === 1) throw new CrashError('between_writes')
      if (w.after) this.files.set(this.key(w.kind, w.id), structuredClone(w.after))
      else this.files.delete(this.key(w.kind, w.id))
    }
    for (const w of b.pages) {
      if (this.crashAt === 'between_writes' && n++ === 1) throw new CrashError('between_writes')
      if (w.after) this.pages.put(structuredClone(w.after))
      else this.pages.delete(w.id)
    }
    for (const h of b.history) {
      const k = this.key(h.recordKind, h.id)
      const list = this.hist.get(k) ?? this.hist.set(k, []).get(k)!
      if (!list.some((x) => x.revision === h.revision)) list.push({ revision: h.revision, body: structuredClone(h.body) })
      list.sort((a, c) => c.revision - a.revision)
      list.length = Math.min(list.length, this.keepHistory)
    }
    if (this.crashAt === 'before_index') throw new CrashError('before_index')
    this.indexGeneration++
  }

  async commit(batch: BatchWrite) {
    if (this.failWith) throw this.failWith
    this.verifyBases(batch, false)
    const j: Journal = { batch: structuredClone(batch), committed: false, applied: false }
    this.journals.set(batch.operationId, j)
    if (this.crashAt === 'before_journal_commit') throw new CrashError('before_journal_commit')
    j.committed = true
    if (this.crashAt === 'after_journal_commit') throw new CrashError('after_journal_commit')
    this.apply(batch)
    j.applied = true
    this.ops.set(batch.operationId, structuredClone(batch.commit))
  }

  async getOperation(id: Id) {
    return this.ops.get(id)
  }

  async loadAll(): Promise<LoadedDatabase> {
    const records: LoadedDatabase['records'] = {}
    const quarantined: LoadedDatabase['quarantined'] = []
    for (const [k, rec] of this.files) {
      const kind = k.split('/')[0] as RecordKind
      if ((rec as { format?: number }).format !== 1) {
        quarantined.push({ kind, id: rec.id, reason: 'unknown record format' })
        continue
      }
      ;(records[kind] ??= []).push(structuredClone(rec) as never)
    }
    return { records, quarantined }
  }

  async loadUndo() {
    return structuredClone(this.undo)
  }
  async saveUndo(g: UndoGroup[]) {
    this.undo = structuredClone(g)
  }
  async history(kind: string, id: Id) {
    return structuredClone(this.hist.get(this.key(kind, id)) ?? [])
  }
}

export type PageSnapshotter = (id: Id) => PageLike | undefined
