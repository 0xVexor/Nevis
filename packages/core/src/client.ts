// Local writes. Each one is ONE transaction that writes the local state, the outbox row (the final envelope bytes, kept
// exactly as first serialised so a resend is always byte-identical) and the advanced clock (ADR-0001 §4).
import { FRAME, MAX_P_CHARS, b64urlEncode, encodeEnvelope, encodeEvt, encodeRec, encodeYUpdate, type Envelope, type Json, type UuidGenerator, uuidv7 } from '@nevis/protocol'
import { KIND_FIELD } from './apply'
import { hashesIn, type BlobStore } from './blobs'
import { nextHlc } from './clock'
import { compactDoc } from './docs'
import type { Store, Tx } from './store'

/** One op may not exceed the envelope limit the server enforces. An op the server refuses for size would sit in the outbox for ever
 *  (a permanent 400), so it is refused HERE, before anything is written: the whole local transaction is undone. */
export class OpTooLargeError extends Error {
  readonly size: number
  constructor(size: number) { super(`this change is too large to save (${Math.round(size / 1024)} KB; the limit is ${Math.round(MAX_P_CHARS / 1024)} KB)`); this.size = size }
}

export interface ClientOptions {
  store: Store
  ws: string
  device: string
  sv: number
  now?: () => number
  newId?: () => string
  /** the random source of sort-key suffixes (a seeded one makes a harness run reproducible) */
  rnd?: () => number
  /** the attachments of this device: an op that refers to one that is not on the server yet is written with the outbox gate (ADR-0005) */
  blobs?: BlobStore
}

export class Client {
  readonly store: Store
  readonly ws: string
  readonly device: string
  readonly sv: number
  private readonly now: () => number
  private readonly newId: () => string
  readonly rnd: () => number
  readonly blobs?: BlobStore
  constructor(o: ClientOptions) {
    this.store = o.store
    this.ws = o.ws
    this.device = o.device
    this.sv = o.sv
    this.now = o.now ?? Date.now
    this.newId = o.newId ?? uuidv7
    this.rnd = o.rnd ?? Math.random
    this.blobs = o.blobs
  }

  /** A fresh id / the current time, for helpers that build entities on this client. */
  newIdFor(): string { return this.newId() }
  nowMs(): number { return this.now() }

  /** The hashes of the attachments that are stored here but not on the server yet. Read BEFORE the transaction (a store transaction
   *  must not wait for anything but its own requests); a blob that became remote meanwhile only makes the gate check redundant. */
  private async pendingBlobs(): Promise<string[]> { return this.blobs ? (await this.blobs.pending()).map(m => m.hash) : [] }

  private async emit(tx: Tx, doc: string, frame: Uint8Array, hlc: string, pending: string[] = []): Promise<string> {
    const env: Envelope = { v: 1, op: this.newId(), ws: this.ws, doc, dev: this.device, t: hlc, sv: this.sv, kid: 0, p: b64urlEncode(frame) }
    if (env.p.length > MAX_P_CHARS) throw new OpTooLargeError(env.p.length)
    const text = encodeEnvelope(env)
    const gate = hashesIn(frame, pending)
    await tx.addOutbox({ op: env.op, env: text, created: this.now(), ...(gate.length ? { blobs: gate } : {}) })
    return env.op
  }

  private async writeRec(tx: Tx, ent: string, set: Record<string, Json>, kind: string | undefined, pending: string[]): Promise<string> {
    const h = await nextHlc(tx, this.device, this.now())
    if (kind !== undefined) await tx.putFieldIfNewer(ent, KIND_FIELD, JSON.stringify(kind), h)
    for (const [f, v] of Object.entries(set)) await tx.putFieldIfNewer(ent, f, JSON.stringify(v), h)
    return this.emit(tx, ent, encodeRec({ ...(kind !== undefined ? { kind } : {}), set, h }), h, pending)
  }

  /** Writes some fields of an entity. `kind` only the first time. Returns the op id. */
  async setFields(ent: string, set: Record<string, Json>, kind?: string): Promise<string> {
    const pending = await this.pendingBlobs()
    return this.store.run(tx => this.writeRec(tx, ent, set, kind, pending))
  }

  /** Several entities in ONE local transaction (a database with its first property and view): a crash never leaves half of it.
   *  Each entity is still its own op, so other devices may see them one by one and must tolerate that. */
  async setFieldsMany(items: { ent: string; set: Record<string, Json>; kind?: string }[]): Promise<string[]> {
    const pending = await this.pendingBlobs()
    return this.store.run(async tx => {
      const ops: string[] = []
      for (const it of items) ops.push(await this.writeRec(tx, it.ent, it.set, it.kind, pending))
      return ops
    })
  }

  /** A Yjs update made on this device for the body of `doc`. */
  async writeYUpdate(doc: string, update: Uint8Array): Promise<string> {
    const pending = await this.pendingBlobs()
    return this.store.run(async tx => {
      const h = await nextHlc(tx, this.device, this.now())
      await tx.appendDocUpdate(doc, update)
      await compactDoc(tx, doc)
      return this.emit(tx, doc, encodeYUpdate(update), h, pending)
    })
  }

  /** An immutable event about an entity (a flashcard review, a page version). */
  async addEvent(ent: string, kind: string, body: Json, id: string = this.newId()): Promise<string> {
    const pending = await this.pendingBlobs()
    return this.store.run(async tx => {
      const h = await nextHlc(tx, this.device, this.now())
      await tx.putEvent({ id, ent, kind, hlc: h, body: JSON.stringify(body) })
      return this.emit(tx, ent, encodeEvt({ id, kind, h, body }), h, pending)
    })
  }
}

export { FRAME }
