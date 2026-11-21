// The one storage interface of the core (ADR-0001). An adapter only keeps these tables and runs a function in ONE atomic
// transaction; the only logic an adapter may hold is "write a register if its HLC is newer" (so that it is atomic).
export interface FieldRow { val: string; hlc: string }
export interface FieldEntry extends FieldRow { ent: string; f: string }
export interface EventRow { id: string; ent: string; kind: string; hlc: string; body: string }
/** `blobs`: the attachments this op refers to that were NOT yet on the server when it was written (the outbox gate, ADR-0005): the op
 *  is not sent until each of them is. Absent = none. */
export interface OutboxRow { op: string; env: string; created: number; blobs?: string[] }
export interface InboxRow { seq: number; env: string }
export interface QuarantineRow { seq: number; env: string; reason: string }
export interface DocUpdate { k: number; upd: Uint8Array }
export interface DocState { state: Uint8Array | null; maxSv: number }

export interface Tx {
  // meta
  getMeta(k: string): Promise<string | undefined>
  setMeta(k: string, v: string): Promise<void>
  // registers (last-writer-wins per field)
  getField(ent: string, f: string): Promise<FieldRow | undefined>
  /** Writes the register when `hlc` is greater than the stored one (or there is none). Returns whether it wrote. */
  putFieldIfNewer(ent: string, f: string, val: string, hlc: string): Promise<boolean>
  /** Changes the HLC of a register from `fromHlc` to `toHlc`, only if it still holds `fromHlc` (the clock-ahead repair). */
  rekeyField(ent: string, f: string, fromHlc: string, toHlc: string): Promise<boolean>
  entityFields(ent: string): Promise<Record<string, FieldRow>>
  entities(): Promise<string[]>
  /** Every register of every entity in ONE read (the page list at startup; a read per entity is too slow at 10 000 pages). */
  allFields(): Promise<FieldEntry[]>
  // events (immutable)
  putEvent(e: EventRow): Promise<boolean>
  /** Gives an event a new HLC (the clock-ahead repair). */
  rekeyEvent(id: string, toHlc: string): Promise<boolean>
  allEvents(): Promise<EventRow[]>
  // documents (Yjs V1)
  getDocState(doc: string): Promise<DocState | undefined>
  putDocState(doc: string, state: Uint8Array, maxSv: number): Promise<void>
  bumpMaxSv(doc: string, sv: number): Promise<void>
  appendDocUpdate(doc: string, upd: Uint8Array): Promise<number>
  listDocUpdates(doc: string): Promise<DocUpdate[]>
  deleteDocUpdates(doc: string, throughK: number): Promise<void>
  docs(): Promise<string[]>
  // outbox / inbox / quarantine
  addOutbox(row: OutboxRow): Promise<void>
  /** In the order the rows were added (not by `created`: the wall clock can go back). */
  listOutbox(limit: number): Promise<OutboxRow[]>
  deleteOutbox(ops: string[]): Promise<void>
  /** Inserts the op if its `seq` is not there yet. Returns whether it inserted. */
  putInbox(row: InboxRow): Promise<boolean>
  listInbox(afterSeq: number, limit: number): Promise<InboxRow[]>
  deleteInbox(seqs: number[]): Promise<void>
  addQuarantine(row: QuarantineRow): Promise<void>
  listQuarantine(): Promise<QuarantineRow[]>
}

export interface Store {
  /** Runs `fn` atomically: everything it wrote is kept if it returns, and nothing is if it throws. Transactions never overlap. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}
