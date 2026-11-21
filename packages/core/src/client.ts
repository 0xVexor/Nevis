// Local writes. Each one is ONE transaction that writes the local state, the outbox row (the final envelope bytes, kept
// exactly as first serialised so a resend is always byte-identical) and the advanced clock (ADR-0001 §4).
import * as Y from 'yjs'
import { FRAME, MAX_P_CHARS, b64urlEncode, encodeEnvelope, encodeEvt, encodeFrame, encodeRec, encodeSnap, encodeYUpdate, type Envelope, type Json, type UuidGenerator, uuidv7 } from '@nevis/protocol'
import { KIND_FIELD } from './apply'
import { hexNamesIn } from './blobs'
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
}

export class Client {
  readonly store: Store
  readonly ws: string
  readonly device: string
  readonly sv: number
  private readonly now: () => number
  private readonly newId: () => string
  readonly rnd: () => number
  constructor(o: ClientOptions) {
    this.store = o.store
    this.ws = o.ws
    this.device = o.device
    this.sv = o.sv
    this.now = o.now ?? Date.now
    this.newId = o.newId ?? uuidv7
    this.rnd = o.rnd ?? Math.random
  }

  /** A fresh id / the current time, for helpers that build entities on this client. */
  newIdFor(): string { return this.newId() }
  nowMs(): number { return this.now() }

  private async emit(tx: Tx, doc: string, frame: Uint8Array, hlc: string, extra: { cov?: number; pg?: 1 } = {}): Promise<string> {
    const env: Envelope = { v: 1, op: this.newId(), ws: this.ws, doc, dev: this.device, t: hlc, sv: this.sv, kid: 0, p: b64urlEncode(frame), ...extra }
    if (env.p.length > MAX_P_CHARS) throw new OpTooLargeError(env.p.length)
    const text = encodeEnvelope(env)
    // EVERY attachment name the op's content holds goes into the gate, whatever this device believes about it (that it came from the server,
    // that it was uploaded): the gate decides when the op is sent, and asks the server then. A name that is not an attachment here is ignored.
    const names = new Set<string>()
    hexNamesIn(frame, names)
    await tx.addOutbox({ op: env.op, env: text, created: this.now(), ...(names.size ? { blobs: [...names] } : {}) })
    return env.op
  }

  private async writeRec(tx: Tx, ent: string, set: Record<string, Json>, kind: string | undefined): Promise<string> {
    const h = await nextHlc(tx, this.device, this.now())
    if (kind !== undefined) await tx.putFieldIfNewer(ent, KIND_FIELD, JSON.stringify(kind), h)
    for (const [f, v] of Object.entries(set)) await tx.putFieldIfNewer(ent, f, JSON.stringify(v), h)
    return this.emit(tx, ent, encodeRec({ ...(kind !== undefined ? { kind } : {}), set, h }), h)
  }

  /** Writes some fields of an entity. `kind` only the first time. Returns the op id. */
  async setFields(ent: string, set: Record<string, Json>, kind?: string): Promise<string> {
    return this.store.run(tx => this.writeRec(tx, ent, set, kind))
  }

  /** Several entities in ONE local transaction (a database with its first property and view): a crash never leaves half of it.
   *  Each entity is still its own op, so other devices may see them one by one and must tolerate that. */
  async setFieldsMany(items: { ent: string; set: Record<string, Json>; kind?: string }[]): Promise<string[]> {
    return this.store.run(async tx => {
      const ops: string[] = []
      for (const it of items) ops.push(await this.writeRec(tx, it.ent, it.set, it.kind))
      return ops
    })
  }

  /** A Yjs update made on this device for the body of `doc`. */
  async writeYUpdate(doc: string, update: Uint8Array): Promise<string> {
    return this.store.run(async tx => {
      const h = await nextHlc(tx, this.device, this.now())
      await tx.appendDocUpdate(doc, update)
      await compactDoc(tx, doc)
      return this.emit(tx, doc, encodeYUpdate(update), h)
    })
  }

  /** A snapshot op of one entity (M13): its registers and its Yjs state as they are now, covering every op up to the cursor. Written only when
   *  the cursor has reached the server's head and NOTHING waits in the inbox (so every op up to the cursor is applied here and none is held
   *  back for a newer schema); null otherwise. The check and the write are one transaction. */
  async writeSnapshot(ent: string): Promise<string | null> {
    return this.store.run(async tx => {
      const cov = Number((await tx.getMeta('cursor')) ?? 0)
      const head = Number((await tx.getMeta('head')) ?? -1)
      if (cov === 0 || cov !== head || (await tx.listInbox(0, 1)).length) return null
      const fields: Record<string, [string, string]> = {}
      for (const [f, r] of Object.entries(await tx.entityFields(ent))) fields[f] = [r.val, r.hlc]
      const st = await tx.getDocState(ent)
      const tail = await tx.listDocUpdates(ent)
      const parts = [...(st?.state ? [st.state] : []), ...tail.map(u => u.upd)]
      const state = parts.length ? Y.mergeUpdates(parts) : new Uint8Array()
      const h = await nextHlc(tx, this.device, this.now())
      return this.emit(tx, ent, encodeSnap({ fields, state }), h, { cov })
    })
  }

  /** Permanent deletion of an entity (M13): this device forgets it in the same transaction that writes the purge op; the server then removes
   *  every op of it and refuses later ones, and every other device forgets it when the op reaches it. */
  async purge(ent: string): Promise<string> {
    return this.store.run(async tx => {
      const h = await nextHlc(tx, this.device, this.now())
      await tx.purgeEntity(ent)
      return this.emit(tx, ent, encodeFrame(FRAME.purge), h, { pg: 1 })
    })
  }

  /** An immutable event about an entity (a flashcard review, a page version). */
  async addEvent(ent: string, kind: string, body: Json, id: string = this.newId()): Promise<string> {
    return this.store.run(async tx => {
      const h = await nextHlc(tx, this.device, this.now())
      await tx.putEvent({ id, ent, kind, hlc: h, body: JSON.stringify(body) })
      return this.emit(tx, ent, encodeEvt({ id, kind, h, body }), h)
    })
  }
}

export { FRAME }
