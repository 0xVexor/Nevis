// The in-memory adapter: the reference for what a `Store` must do, and the store of the convergence harness. Atomicity is an
// undo journal: every write records how to undo itself, and a throwing transaction replays the journal backwards.
// What a "crash" keeps is exactly the committed state of this object.
import type { DocState, DocUpdate, EventRow, FieldRow, InboxRow, OutboxRow, QuarantineRow, Store, Tx } from './store'

export class MemoryStore implements Store {
  private meta = new Map<string, string>()
  private fields = new Map<string, Map<string, FieldRow>>()
  private eventRows = new Map<string, EventRow>()
  private docState = new Map<string, DocState>()
  private docUpdates = new Map<string, DocUpdate[]>()
  private docSeq = new Map<string, number>()
  private outbox = new Map<string, OutboxRow>()
  private inbox = new Map<number, InboxRow>()
  private quarantine = new Map<number, QuarantineRow>()
  private lock: Promise<unknown> = Promise.resolve()
  commits = 0

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const next = this.lock.then(() => this.exec(fn))
    this.lock = next.catch(() => undefined)
    return next
  }

  private async exec<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const undo: (() => void)[] = []
    try {
      const out = await fn(this.tx(undo))
      this.commits++
      return out
    } catch (e) {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]!()
      throw e
    }
  }

  private mapSet<K, V>(m: Map<K, V>, k: K, v: V, undo: (() => void)[]) {
    const had = m.has(k), old = m.get(k)
    undo.push(() => (had ? m.set(k, old as V) : m.delete(k)))
    m.set(k, v)
  }
  private mapDel<K, V>(m: Map<K, V>, k: K, undo: (() => void)[]) {
    if (!m.has(k)) return
    const old = m.get(k) as V
    undo.push(() => m.set(k, old))
    m.delete(k)
  }

  private tx(undo: (() => void)[]): Tx {
    return {
      getMeta: async k => this.meta.get(k),
      setMeta: async (k, v) => this.mapSet(this.meta, k, v, undo),
      getField: async (ent, f) => this.fields.get(ent)?.get(f),
      putFieldIfNewer: async (ent, f, val, hlc) => {
        let m = this.fields.get(ent)
        const cur = m?.get(f)
        if (cur && cur.hlc >= hlc) return false
        if (!m) { m = new Map(); this.mapSet(this.fields, ent, m, undo) }
        this.mapSet(m, f, { val, hlc }, undo)
        return true
      },
      entityFields: async ent => Object.fromEntries(this.fields.get(ent) ?? []),
      entities: async () => [...this.fields.keys()],
      putEvent: async e => {
        if (this.eventRows.has(e.id)) return false
        this.mapSet(this.eventRows, e.id, e, undo)
        return true
      },
      allEvents: async () => [...this.eventRows.values()],
      getDocState: async doc => this.docState.get(doc),
      putDocState: async (doc, state, maxSv) => this.mapSet(this.docState, doc, { state, maxSv }, undo),
      bumpMaxSv: async (doc, sv) => {
        const cur = this.docState.get(doc) ?? { state: null, maxSv: 0 }
        if (sv > cur.maxSv) this.mapSet(this.docState, doc, { ...cur, maxSv: sv }, undo)
      },
      appendDocUpdate: async (doc, upd) => {
        const k = (this.docSeq.get(doc) ?? 0) + 1
        this.mapSet(this.docSeq, doc, k, undo)
        const list = this.docUpdates.get(doc) ?? []
        this.mapSet(this.docUpdates, doc, [...list, { k, upd }], undo)
        return k
      },
      listDocUpdates: async doc => [...(this.docUpdates.get(doc) ?? [])],
      deleteDocUpdates: async (doc, throughK) => this.mapSet(this.docUpdates, doc, (this.docUpdates.get(doc) ?? []).filter(u => u.k > throughK), undo),
      docs: async () => [...new Set([...this.docState.keys(), ...this.docUpdates.keys()])],
      addOutbox: async row => this.mapSet(this.outbox, row.op, row, undo),
      listOutbox: async limit => [...this.outbox.values()].slice(0, limit), // a Map keeps insertion order
      deleteOutbox: async ops => { for (const op of ops) this.mapDel(this.outbox, op, undo) },
      putInbox: async row => {
        if (this.inbox.has(row.seq)) return false
        this.mapSet(this.inbox, row.seq, row, undo)
        return true
      },
      listInbox: async (after, limit) => [...this.inbox.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit),
      deleteInbox: async seqs => { for (const s of seqs) this.mapDel(this.inbox, s, undo) },
      addQuarantine: async row => this.mapSet(this.quarantine, row.seq, row, undo),
      listQuarantine: async () => [...this.quarantine.values()].sort((a, b) => a.seq - b.seq),
    }
  }
}
