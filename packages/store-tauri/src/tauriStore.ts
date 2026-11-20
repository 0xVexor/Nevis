// The desktop adapter of the core's `Store` (ADR-0001 §7): SQLite in Rust, reached over IPC.
//
// The core runs an INTERACTIVE transaction (reads and conditional writes interleaved), the IPC is ONE command per transaction.
// So a `run` works like this: reads ask Rust for COMMITTED state (`store_read`) and are completed with an overlay of what this
// transaction has written so far; writes are only recorded; when the function returns, the recorded list goes to Rust as one
// `store_commit`, which applies it in one SQLite transaction. Every conditional write carries the result this side assumed
// (`wrote`, `inserted`, `k`, `ok`) and Rust refuses (and rolls back) the whole batch if the real rows disagree.
// This is correct only while this adapter is the ONLY writer of the database, and transactions never overlap (a queue below).
import type { DocState, DocUpdate, EventRow, FieldEntry, FieldRow, InboxRow, OutboxRow, QuarantineRow, Store, Tx } from '@nevis/core'

export type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>
export interface TauriStoreOptions {
  ws: string
  invoke: Invoke
  /** called with the duration of each `store_commit` (the IPC benchmark) */
  onCommit?: (ms: number, ops: number) => void
}

const toB64 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const key = (ent: string, f: string) => `${ent}\u0000${f}`

export class TauriStore implements Store {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly o: TauriStoreOptions
  constructor(o: TauriStoreOptions) { this.o = o }

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.exec(fn))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async exec<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const read = (req: Record<string, unknown>) => this.o.invoke('store_read', { ws: this.o.ws, req })
    const ops: Record<string, unknown>[] = []
    const out = await fn(makeTx(read, ops)) // a throw here sends nothing: the transaction never existed for Rust
    if (ops.length) {
      const t0 = performance.now()
      await this.o.invoke('store_commit', { ws: this.o.ws, ops })
      this.o.onCommit?.(performance.now() - t0, ops.length)
    }
    return out
  }
}

type Read = (req: Record<string, unknown>) => Promise<unknown>

function makeTx(read: Read, ops: Record<string, unknown>[]): Tx {
  // the overlay: what this transaction has written, on top of the committed rows
  const meta = new Map<string, string>()
  const fields = new Map<string, FieldEntry>()
  const events = new Map<string, EventRow>()
  const docState = new Map<string, DocState>()
  const docSeq = new Map<string, number>()
  const addedUpdates = new Map<string, DocUpdate[]>()
  const deletedThrough = new Map<string, number>()
  const addedOutbox: OutboxRow[] = []
  const deletedOutbox = new Set<string>()
  const addedInbox = new Map<number, string>()
  const deletedInbox = new Set<number>()
  const addedQuarantine = new Map<number, QuarantineRow>()

  const getField = async (ent: string, f: string): Promise<FieldRow | undefined> => {
    const p = fields.get(key(ent, f))
    if (p) return { val: p.val, hlc: p.hlc }
    return ((await read({ t: 'getField', ent, f })) as FieldRow | null) ?? undefined
  }
  const getEvent = async (id: string): Promise<EventRow | undefined> => events.get(id) ?? (((await read({ t: 'getEvent', id })) as EventRow | null) ?? undefined)
  const getDocState = async (doc: string): Promise<DocState | undefined> => {
    const p = docState.get(doc)
    if (p) return p
    const r = (await read({ t: 'getDocState', doc })) as { state: string | null; maxSv: number } | null
    return r ? { state: r.state === null ? null : fromB64(r.state), maxSv: r.maxSv } : undefined
  }

  return {
    getMeta: async k => meta.get(k) ?? (((await read({ t: 'getMeta', k })) as string | null) ?? undefined),
    setMeta: async (k, v) => { meta.set(k, v); ops.push({ t: 'setMeta', k, v }) },

    getField,
    putFieldIfNewer: async (ent, f, val, hlc) => {
      const cur = await getField(ent, f)
      const wrote = !cur || cur.hlc < hlc
      ops.push({ t: 'putField', ent, f, val, hlc, wrote })
      if (wrote) fields.set(key(ent, f), { ent, f, val, hlc })
      return wrote
    },
    rekeyField: async (ent, f, from, to) => {
      const cur = await getField(ent, f)
      const ok = !!cur && cur.hlc === from
      ops.push({ t: 'rekeyField', ent, f, from, to, ok })
      if (ok) fields.set(key(ent, f), { ent, f, val: cur!.val, hlc: to })
      return ok
    },
    entityFields: async ent => {
      const rows = (await read({ t: 'entityFields', ent })) as { f: string; val: string; hlc: string }[]
      const out: Record<string, FieldRow> = Object.fromEntries(rows.map(r => [r.f, { val: r.val, hlc: r.hlc }]))
      for (const p of fields.values()) if (p.ent === ent) out[p.f] = { val: p.val, hlc: p.hlc }
      return out
    },
    allFields: async () => {
      const rows = (await read({ t: 'allFields' })) as [string, string, string, string][]
      if (!fields.size) return rows.map(([ent, f, val, hlc]) => ({ ent, f, val, hlc }))
      const m = new Map<string, FieldEntry>(rows.map(([ent, f, val, hlc]) => [key(ent, f), { ent, f, val, hlc }]))
      for (const [k, v] of fields) m.set(k, v)
      return [...m.values()]
    },
    entities: async () => {
      const s = new Set((await read({ t: 'entities' })) as string[])
      for (const p of fields.values()) s.add(p.ent)
      return [...s].sort()
    },

    putEvent: async e => {
      const inserted = !(await getEvent(e.id))
      ops.push({ t: 'putEvent', ev: e, inserted })
      if (inserted) events.set(e.id, e)
      return inserted
    },
    rekeyEvent: async (id, to) => {
      const e = await getEvent(id)
      ops.push({ t: 'rekeyEvent', id, to, ok: !!e })
      if (e) events.set(id, { ...e, hlc: to })
      return !!e
    },
    allEvents: async () => {
      const m = new Map<string, EventRow>(((await read({ t: 'allEvents' })) as EventRow[]).map(e => [e.id, e]))
      for (const [id, e] of events) m.set(id, e)
      return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },

    getDocState,
    putDocState: async (doc, state, maxSv) => { docState.set(doc, { state, maxSv }); ops.push({ t: 'putDocState', doc, state: toB64(state), maxSv }) },
    bumpMaxSv: async (doc, sv) => {
      const cur = await getDocState(doc)
      if (!cur) docState.set(doc, { state: null, maxSv: sv })
      else if (sv > cur.maxSv) docState.set(doc, { ...cur, maxSv: sv })
      ops.push({ t: 'bumpMaxSv', doc, sv })
    },
    appendDocUpdate: async (doc, upd) => {
      const k = ((docSeq.get(doc) ?? ((await read({ t: 'docSeq', doc })) as number)) as number) + 1
      docSeq.set(doc, k)
      const list = addedUpdates.get(doc) ?? []
      list.push({ k, upd })
      addedUpdates.set(doc, list)
      ops.push({ t: 'appendDocUpdate', doc, upd: toB64(upd), k })
      return k
    },
    listDocUpdates: async doc => {
      const rows = ((await read({ t: 'listDocUpdates', doc })) as { k: number; upd: string }[]).map(r => ({ k: r.k, upd: fromB64(r.upd) }))
      const through = deletedThrough.get(doc) ?? 0
      return [...rows, ...(addedUpdates.get(doc) ?? [])].filter(u => u.k > through)
    },
    deleteDocUpdates: async (doc, throughK) => {
      deletedThrough.set(doc, Math.max(deletedThrough.get(doc) ?? 0, throughK))
      ops.push({ t: 'deleteDocUpdates', doc, through: throughK })
    },
    docs: async () => {
      const s = new Set((await read({ t: 'docs' })) as string[])
      for (const d of docState.keys()) s.add(d)
      for (const d of docSeq.keys()) s.add(d)
      return [...s]
    },

    addOutbox: async row => { addedOutbox.push({ ...row }); ops.push({ t: 'addOutbox', op: row.op, env: row.env, created: row.created }) },
    listOutbox: async limit => {
      const committed = (await read({ t: 'listOutbox', limit: limit + deletedOutbox.size })) as OutboxRow[]
      return [...committed.filter(r => !deletedOutbox.has(r.op)), ...addedOutbox.filter(r => !deletedOutbox.has(r.op))].slice(0, limit)
    },
    deleteOutbox: async list => { for (const op of list) deletedOutbox.add(op); ops.push({ t: 'deleteOutbox', ops: list }) },

    putInbox: async row => {
      const exists = addedInbox.has(row.seq) || (!deletedInbox.has(row.seq) && ((await read({ t: 'hasInbox', seq: row.seq })) as boolean))
      const inserted = !exists
      ops.push({ t: 'putInbox', seq: row.seq, env: row.env, inserted })
      if (inserted) { addedInbox.set(row.seq, row.env); deletedInbox.delete(row.seq) }
      return inserted
    },
    listInbox: async (after, limit) => {
      const committed = (await read({ t: 'listInbox', after, limit: limit + deletedInbox.size })) as InboxRow[]
      const m = new Map<number, string>(committed.filter(r => !deletedInbox.has(r.seq)).map(r => [r.seq, r.env]))
      for (const [seq, env] of addedInbox) if (seq > after) m.set(seq, env)
      return [...m].sort((a, b) => a[0] - b[0]).slice(0, limit).map(([seq, env]) => ({ seq, env }))
    },
    deleteInbox: async seqs => {
      for (const q of seqs) { addedInbox.delete(q); deletedInbox.add(q) }
      ops.push({ t: 'deleteInbox', seqs })
    },

    addQuarantine: async row => { addedQuarantine.set(row.seq, { ...row }); ops.push({ t: 'addQuarantine', seq: row.seq, env: row.env, reason: row.reason }) },
    listQuarantine: async () => {
      const m = new Map<number, QuarantineRow>(((await read({ t: 'listQuarantine' })) as QuarantineRow[]).map(r => [r.seq, r]))
      for (const [seq, r] of addedQuarantine) m.set(seq, r)
      return [...m.values()].sort((a, b) => a.seq - b.seq)
    },
  }
}
