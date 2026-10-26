// IndexedDB adapter (browser). One batch = one transaction over the affected stores, so a crash or a closed tab leaves either the
// whole batch or none of it: the IDB transaction is the journal. The page store is the app's own `pages` store, written in the
// same transaction as the database records.
import type { Commit, Id, Json, RecordKind } from '../model/types.ts'
import { DbError } from '../model/errors.ts'
import type { AnyRecord } from '../state.ts'
import type { BatchWrite, DbStorage, LoadedDatabase, UndoGroup } from './types.ts'

export const DB_STORES = ['db_records', 'db_history', 'db_ops', 'db_meta', 'db_runtime'] as const
export const DB_SCHEMA_VERSION = 2 // not.db v1 = pages/versions/kv, v2 adds the database stores

/** Called from the app's `onupgradeneeded`. Creating missing stores only: existing page data is never touched. */
export function upgradeDatabaseStores(d: IDBDatabase) {
  if (!d.objectStoreNames.contains('db_records')) d.createObjectStore('db_records') // key `${kind}/${id}`
  if (!d.objectStoreNames.contains('db_history')) d.createObjectStore('db_history') // key `${kind}/${id}/${revision padded}`
  if (!d.objectStoreNames.contains('db_ops')) d.createObjectStore('db_ops') // operation results (idempotency)
  if (!d.objectStoreNames.contains('db_meta')) d.createObjectStore('db_meta') // undo stack, index generation
  if (!d.objectStoreNames.contains('db_runtime')) d.createObjectStore('db_runtime') // workflow pending windows, cursors
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })
const wrap = <T,>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const pad = (n: number) => String(n).padStart(10, '0')
export const OPS_KEEP = 5000
export const HISTORY_KEEP = 50

export class IdbStorage implements DbStorage {
  private open: () => Promise<IDBDatabase>
  private channel: BroadcastChannel | null = null
  private listeners = new Set<(info: { changed: { recordKind: string; id: Id }[] }) => void>()

  constructor(open: () => Promise<IDBDatabase>) {
    this.open = open
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('noviq-database')
      this.channel.onmessage = (m) => this.listeners.forEach((f) => f(m.data))
      ;(this.channel as unknown as { unref?: () => void }).unref?.() // do not keep a Node process (tests) alive
    }
  }

  /** Another tab committed: reload records (the coordinator calls reloadExternal). */
  onExternal(fn: (info: { changed: { recordKind: string; id: Id }[] }) => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  async recover() {
    return { replayed: 0 } // IndexedDB transactions are atomic: there is never a half-applied batch to replay
  }

  async loadAll(): Promise<LoadedDatabase> {
    const d = await this.open()
    const tx = d.transaction('db_records')
    const rows = (await wrap(tx.objectStore('db_records').getAll())) as AnyRecord[]
    const keys = (await wrap(tx.objectStore('db_records').getAllKeys())) as string[]
    const records: LoadedDatabase['records'] = {}
    const quarantined: LoadedDatabase['quarantined'] = []
    rows.forEach((r, i) => {
      const kind = keys[i].split('/')[0] as RecordKind
      if ((r as { format?: number }).format !== 1) quarantined.push({ kind, id: (r as { id?: string }).id ?? keys[i], reason: 'unknown record format' })
      else (records[kind] ??= []).push(r as never)
    })
    return { records, quarantined }
  }

  async commit(batch: BatchWrite) {
    const d = await this.open()
    const tx = d.transaction(['db_records', 'db_history', 'db_ops', 'pages'], 'readwrite')
    const rec = tx.objectStore('db_records')
    const pages = tx.objectStore('pages')
    try {
      // refuse a stale writer (another tab): compare against what is stored *inside* the transaction
      for (const w of batch.records) {
        const cur = (await wrap(rec.get(`${w.kind}/${w.id}`))) as { revision?: number } | undefined
        if ((cur?.revision ?? 0) !== w.baseRevision) throw new DbError('REVISION_CONFLICT', `${w.kind}/${w.id} was changed by another tab`, { recordKind: w.kind, id: w.id, expected: w.baseRevision, current: cur?.revision ?? 0 })
      }
      for (const w of batch.pages) {
        const cur = (await wrap(pages.get(w.id))) as { recordMeta?: { revision?: number } } | undefined
        if (cur && (cur.recordMeta?.revision ?? 0) !== w.baseRevision) throw new DbError('REVISION_CONFLICT', `page/${w.id} was changed by another tab`, { recordKind: 'page', id: w.id, expected: w.baseRevision, current: cur.recordMeta?.revision ?? 0 })
      }
      for (const w of batch.records) (w.after ? rec.put(w.after, `${w.kind}/${w.id}`) : rec.delete(`${w.kind}/${w.id}`))
      for (const w of batch.pages) {
        if (!w.after) { pages.delete(w.id); continue }
        // a post-image without a body (lazy loading) must never wipe the stored body
        const cur = (await wrap(pages.get(w.id))) as { content?: unknown } | undefined
        pages.put(w.after.content === undefined || w.after.content === null ? { ...w.after, ...(cur?.content != null ? { content: cur.content } : {}) } : w.after)
      }
      const hist = tx.objectStore('db_history')
      for (const h of batch.history) hist.put({ revision: h.revision, body: h.body }, `${h.recordKind}/${h.id}/${pad(h.revision)}`)
      tx.objectStore('db_ops').put(batch.commit, batch.operationId)
    } catch (e) {
      tx.abort()
      await done(tx).catch(() => undefined)
      throw e
    }
    try {
      await done(tx)
    } catch (e) {
      const err = e as DOMException
      if (err?.name === 'QuotaExceededError') throw new DbError('QUOTA', 'the browser storage is full', {})
      throw new DbError('IO', err?.message ?? String(e))
    }
    this.channel?.postMessage({ changed: batch.commit.changed.map((c) => ({ recordKind: c.recordKind, id: c.id })) })
    void this.pruneOps().catch(() => undefined)
    void this.pruneHistory(batch).catch(() => undefined)
  }

  private async pruneOps() {
    const d = await this.open()
    const keys = (await wrap(d.transaction('db_ops').objectStore('db_ops').getAllKeys())) as string[]
    if (keys.length <= OPS_KEEP) return
    const tx = d.transaction('db_ops', 'readwrite')
    for (const k of keys.slice(0, keys.length - OPS_KEEP)) tx.objectStore('db_ops').delete(k)
    await done(tx)
  }

  private async pruneHistory(batch: BatchWrite) {
    const d = await this.open()
    for (const h of batch.history) {
      const prefix = `${h.recordKind}/${h.id}/`
      const range = IDBKeyRange.bound(prefix, prefix + '￿')
      const keys = (await wrap(d.transaction('db_history').objectStore('db_history').getAllKeys(range))) as string[]
      if (keys.length <= HISTORY_KEEP) continue
      const tx = d.transaction('db_history', 'readwrite')
      for (const k of keys.slice(0, keys.length - HISTORY_KEEP)) tx.objectStore('db_history').delete(k)
      await done(tx)
    }
  }

  async getOperation(id: Id): Promise<Commit | undefined> {
    const d = await this.open()
    return wrap(d.transaction('db_ops').objectStore('db_ops').get(id)) as Promise<Commit | undefined>
  }

  async loadUndo(): Promise<UndoGroup[]> {
    const d = await this.open()
    return ((await wrap(d.transaction('db_meta').objectStore('db_meta').get('undo'))) as UndoGroup[] | undefined) ?? []
  }
  async saveUndo(groups: UndoGroup[]) {
    const d = await this.open()
    const tx = d.transaction('db_meta', 'readwrite')
    tx.objectStore('db_meta').put(JSON.parse(JSON.stringify(groups)), 'undo')
    await done(tx)
  }

  async history(kind: string, id: Id): Promise<{ revision: number; body: Json }[]> {
    const d = await this.open()
    const prefix = `${kind}/${id}/`
    const rows = (await wrap(d.transaction('db_history').objectStore('db_history').getAll(IDBKeyRange.bound(prefix, prefix + '￿')))) as { revision: number; body: Json }[]
    return rows.sort((a, b) => b.revision - a.revision)
  }

  // workflow runtime state (device local): pending trigger windows, schedule cursors
  runtime() {
    const open = this.open
    return {
      async get(key: string) { return wrap((await open()).transaction('db_runtime').objectStore('db_runtime').get(key)) as Promise<Json | undefined> },
      async set(key: string, value: Json) { const tx = (await open()).transaction('db_runtime', 'readwrite'); tx.objectStore('db_runtime').put(value, key); await done(tx) },
      async delete(key: string) { const tx = (await open()).transaction('db_runtime', 'readwrite'); tx.objectStore('db_runtime').delete(key); await done(tx) },
      async keys(prefix: string) { return ((await wrap((await open()).transaction('db_runtime').objectStore('db_runtime').getAllKeys())) as string[]).filter((k) => k.startsWith(prefix)) },
    }
  }
}

