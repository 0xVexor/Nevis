// The IndexedDB adapter of the core's `Store` (ADR-0001). One `run` = ONE readwrite transaction over every store.
//
// Rules this file keeps (R2 §5, the Safari auto-commit trap): inside a transaction only IndexedDB requests are awaited, so
// the transaction never has an idle moment in which the browser may commit it; a connection that has become invalid is
// reopened; a newer tab that upgrades the database makes this one close instead of blocking it.
import type { DocState, DocUpdate, EventRow, FieldEntry, FieldRow, InboxRow, OutboxRow, QuarantineRow, Store, Tx } from '@nevis/core'

export const DB_VERSION = 1
const STORES = ['meta', 'fields', 'events', 'doc_state', 'doc_seq', 'doc_update', 'outbox', 'inbox', 'quarantine'] as const

export class StoreClosedError extends Error {
  constructor() { super('another tab opened a newer version of the local database; reload this page') }
}

export interface IdbStoreOptions {
  /** the database name, `nevis-<workspaceId>` (ADR-0001 §6) */
  name: string
  indexedDB?: IDBFactory
  /** called when a newer tab upgrades the database and this connection had to close */
  onVersionChange?: () => void
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error) })

function upgrade(db: IDBDatabase) {
  db.createObjectStore('meta')
  const fields = db.createObjectStore('fields', { keyPath: ['ent', 'f'] })
  fields.createIndex('byEnt', 'ent')
  db.createObjectStore('events', { keyPath: 'id' })
  db.createObjectStore('doc_state', { keyPath: 'doc' })
  db.createObjectStore('doc_seq', { keyPath: 'doc' })
  db.createObjectStore('doc_update', { keyPath: ['doc', 'k'] })
  const outbox = db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true })
  outbox.createIndex('byOp', 'op', { unique: true })
  db.createObjectStore('inbox', { keyPath: 'seq' })
  db.createObjectStore('quarantine', { keyPath: 'seq' })
}

export class IdbStore implements Store {
  private readonly o: IdbStoreOptions
  private db: Promise<IDBDatabase> | null = null
  private closed = false
  constructor(o: IdbStoreOptions) { this.o = o }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((ok, bad) => {
      const factory = this.o.indexedDB ?? indexedDB
      const r = factory.open(this.o.name, DB_VERSION)
      r.onupgradeneeded = () => upgrade(r.result)
      r.onblocked = () => bad(new Error('the local database is blocked by another tab'))
      r.onerror = () => { this.db = null; bad(r.error) }
      r.onsuccess = () => {
        const d = r.result
        d.onversionchange = () => { d.close(); this.closed = true; this.db = null; this.o.onVersionChange?.() }
        d.onclose = () => { this.db = null } // the browser dropped the connection (storage cleared, crash): reopen on demand
        ok(d)
      }
    }))
  }

  async close() { (await this.db)?.close(); this.db = null }

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new StoreClosedError()
    let t: IDBTransaction
    try {
      t = (await this.open()).transaction([...STORES], 'readwrite', { durability: 'strict' })
    } catch (e) {
      if ((e as DOMException).name !== 'InvalidStateError') throw e
      this.db = null // a closed connection: open it again, once
      t = (await this.open()).transaction([...STORES], 'readwrite', { durability: 'strict' })
    }
    const finished = new Promise<void>((ok, bad) => {
      t.oncomplete = () => ok()
      t.onerror = () => bad(t.error)
      t.onabort = () => bad(t.error ?? new Error('transaction aborted'))
    })
    finished.catch(() => undefined) // the error is reported through `await finished` below
    let out: T
    try {
      out = await fn(makeTx(t))
    } catch (e) {
      try { t.abort() } catch { /* already finished */ }
      await finished.catch(() => undefined)
      throw e
    }
    await finished
    return out
  }
}

function makeTx(t: IDBTransaction): Tx {
  const s = (n: (typeof STORES)[number]) => t.objectStore(n)
  return {
    getMeta: async k => (await req(s('meta').get(k))) as string | undefined,
    setMeta: async (k, v) => { await req(s('meta').put(v, k)) },

    getField: async (ent, f) => {
      const r = (await req(s('fields').get([ent, f]))) as { val: string; hlc: string } | undefined
      return r && { val: r.val, hlc: r.hlc }
    },
    putFieldIfNewer: async (ent, f, val, hlc) => {
      const cur = (await req(s('fields').get([ent, f]))) as { hlc: string } | undefined
      if (cur && cur.hlc >= hlc) return false
      await req(s('fields').put({ ent, f, val, hlc }))
      return true
    },
    rekeyField: async (ent, f, from, to) => {
      const cur = (await req(s('fields').get([ent, f]))) as { val: string; hlc: string } | undefined
      if (!cur || cur.hlc !== from) return false
      await req(s('fields').put({ ent, f, val: cur.val, hlc: to }))
      return true
    },
    entityFields: async ent => {
      const rows = (await req(s('fields').index('byEnt').getAll(ent))) as { f: string; val: string; hlc: string }[]
      return Object.fromEntries(rows.map(r => [r.f, { val: r.val, hlc: r.hlc } as FieldRow]))
    },
    allFields: async () => (await req(s('fields').getAll())) as FieldEntry[],
    entities: async () => {
      const out: string[] = []
      await new Promise<void>((ok, bad) => {
        const c = s('fields').index('byEnt').openKeyCursor(null, 'nextunique')
        c.onsuccess = () => { const cur = c.result; if (!cur) return ok(); out.push(cur.key as string); cur.continue() }
        c.onerror = () => bad(c.error)
      })
      return out
    },

    putEvent: async e => {
      if ((await req(s('events').get(e.id))) !== undefined) return false
      await req(s('events').put(e))
      return true
    },
    rekeyEvent: async (id, to) => {
      const e = (await req(s('events').get(id))) as EventRow | undefined
      if (!e) return false
      await req(s('events').put({ ...e, hlc: to }))
      return true
    },
    allEvents: async () => (await req(s('events').getAll())) as EventRow[],

    getDocState: async doc => {
      const r = (await req(s('doc_state').get(doc))) as { state: Uint8Array | null; maxSv: number } | undefined
      return r && ({ state: r.state, maxSv: r.maxSv } as DocState)
    },
    putDocState: async (doc, state, maxSv) => { await req(s('doc_state').put({ doc, state, maxSv })) },
    bumpMaxSv: async (doc, sv) => {
      const cur = (await req(s('doc_state').get(doc))) as { state: Uint8Array | null; maxSv: number } | undefined
      if (!cur) await req(s('doc_state').put({ doc, state: null, maxSv: sv }))
      else if (sv > cur.maxSv) await req(s('doc_state').put({ ...cur, maxSv: sv }))
    },
    appendDocUpdate: async (doc, upd) => {
      const cur = (await req(s('doc_seq').get(doc))) as { k: number } | undefined
      const k = (cur?.k ?? 0) + 1
      await req(s('doc_seq').put({ doc, k }))
      await req(s('doc_update').put({ doc, k, upd }))
      return k
    },
    listDocUpdates: async doc => {
      const rows = (await req(s('doc_update').getAll(IDBKeyRange.bound([doc, 0], [doc, Number.MAX_SAFE_INTEGER])))) as { k: number; upd: Uint8Array }[]
      return rows.map(r => ({ k: r.k, upd: r.upd }) as DocUpdate)
    },
    deleteDocUpdates: async (doc, throughK) => { await req(s('doc_update').delete(IDBKeyRange.bound([doc, 0], [doc, throughK]))) },
    purgeEntity: async ent => {
      for (const k of (await req(s('fields').index('byEnt').getAllKeys(ent))) as IDBValidKey[]) await req(s('fields').delete(k))
      for (const e of (await req(s('events').getAll())) as EventRow[]) if (e.ent === ent) await req(s('events').delete(e.id))
      await req(s('doc_state').delete(ent)); await req(s('doc_seq').delete(ent))
      await req(s('doc_update').delete(IDBKeyRange.bound([ent, 0], [ent, Number.MAX_SAFE_INTEGER])))
    },
    docs: async () => {
      const a = (await req(s('doc_state').getAllKeys())) as string[]
      const b = (await req(s('doc_seq').getAllKeys())) as string[]
      return [...new Set([...a, ...b])]
    },

    addOutbox: async row => { await req(s('outbox').put({ op: row.op, env: row.env, created: row.created, ...(row.blobs?.length ? { blobs: row.blobs } : {}) })) },
    listOutbox: async limit => {
      const rows = (await req(s('outbox').getAll(null, limit))) as { op: string; env: string; created: number; blobs?: string[] }[]
      return rows.map(r => ({ op: r.op, env: r.env, created: r.created, ...(r.blobs?.length ? { blobs: r.blobs } : {}) }) as OutboxRow)
    },
    deleteOutbox: async ops => {
      const idx = s('outbox').index('byOp')
      for (const op of ops) {
        const key = await req(idx.getKey(op))
        if (key !== undefined) await req(s('outbox').delete(key))
      }
    },

    putInbox: async row => {
      if ((await req(s('inbox').get(row.seq))) !== undefined) return false
      await req(s('inbox').put(row))
      return true
    },
    listInbox: async (after, limit) => (await req(s('inbox').getAll(IDBKeyRange.lowerBound(after, true), limit))) as InboxRow[],
    deleteInbox: async seqs => { for (const q of seqs) await req(s('inbox').delete(q)) },

    addQuarantine: async row => { await req(s('quarantine').put(row)) },
    listQuarantine: async () => (await req(s('quarantine').getAll())) as QuarantineRow[],
  }
}
