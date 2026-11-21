// The payload frame (ADR-0005): the first byte is the kind, the rest is the data. Only clients read it.
import { parseStrictBytes, type Json } from './json'

export const FRAME = { rec: 0x01, yupd: 0x02, evt: 0x03, snap: 0x04, purge: 0x05 } as const
export type FrameKind = (typeof FRAME)[keyof typeof FRAME]

export class FrameError extends Error {}

export function encodeFrame(kind: FrameKind, data: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(1 + data.length)
  out[0] = kind
  out.set(data, 1)
  return out
}

export function decodeFrame(p: Uint8Array): { kind: FrameKind; data: Uint8Array } {
  if (p.length < 1) throw new FrameError('empty payload')
  const kind = p[0]!
  if (!Object.values(FRAME).includes(kind as FrameKind)) throw new FrameError(`unknown frame kind ${kind}`)
  return { kind: kind as FrameKind, data: p.subarray(1) }
}

const enc = new TextEncoder()
export const jsonBytes = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v))

/** `rec`: a write of some fields of an entity. `kind` only in the op that creates the entity. */
export interface RecPayload { kind?: string; set: Record<string, Json>; h: string }
/** `evt`: an immutable event (a flashcard review, a page version). */
export interface EvtPayload { id: string; kind: string; h: string; body: Json }

export const encodeRec = (r: RecPayload): Uint8Array => encodeFrame(FRAME.rec, jsonBytes(r))
export const encodeEvt = (e: EvtPayload): Uint8Array => encodeFrame(FRAME.evt, jsonBytes(e))
export const encodeYUpdate = (u: Uint8Array): Uint8Array => encodeFrame(FRAME.yupd, u)

export function decodeRec(data: Uint8Array): RecPayload {
  const o = parseStrictBytes(data)
  if (o === null || typeof o !== 'object' || Array.isArray(o) || typeof o.h !== 'string' || o.set === null || typeof o.set !== 'object' || Array.isArray(o.set)) throw new FrameError('bad rec')
  if (o.kind !== undefined && typeof o.kind !== 'string') throw new FrameError('bad rec kind')
  return o as unknown as RecPayload
}

export function decodeEvt(data: Uint8Array): EvtPayload {
  const o = parseStrictBytes(data)
  if (o === null || typeof o !== 'object' || Array.isArray(o) || typeof o.id !== 'string' || typeof o.kind !== 'string' || typeof o.h !== 'string' || !('body' in o)) throw new FrameError('bad evt')
  return o as unknown as EvtPayload
}

/** `snap` (M13): the state of ONE entity at the moment of the snapshot: its registers (value + the HLC that wrote it) and, if it has a body,
 *  the Yjs state. Layout: u32 big-endian length of the JSON, the JSON `{"fields":{"title":["\"x\"","<hlc>"]}}` (values are the stored JSON text),
 *  then the Yjs V1 state (possibly empty). */
export interface SnapEvent { id: string; kind: string; hlc: string; body: Json }
export interface SnapPayload { fields: Record<string, [string, string]>; /** the entity's events (versions, reviews): ops of the entity that a snapshot covers must not lose them */ events: SnapEvent[]; state: Uint8Array }

export function encodeSnap(s: SnapPayload): Uint8Array {
  const json = jsonBytes({ fields: s.fields, events: s.events })
  const out = new Uint8Array(4 + json.length + s.state.length)
  new DataView(out.buffer).setUint32(0, json.length)
  out.set(json, 4); out.set(s.state, 4 + json.length)
  return encodeFrame(FRAME.snap, out)
}

export function decodeSnap(data: Uint8Array): SnapPayload {
  if (data.length < 4) throw new FrameError('bad snap')
  const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)
  if (4 + n > data.length) throw new FrameError('bad snap length')
  const o = parseStrictBytes(data.subarray(4, 4 + n))
  if (o === null || typeof o !== 'object' || Array.isArray(o) || o.fields === null || typeof o.fields !== 'object' || Array.isArray(o.fields)) throw new FrameError('bad snap fields')
  const fields: Record<string, [string, string]> = {}
  for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') throw new FrameError('bad snap field')
    fields[k] = [v[0], v[1]]
  }
  const events: SnapEvent[] = []
  if (o.events !== undefined) {
    if (!Array.isArray(o.events)) throw new FrameError('bad snap events')
    for (const e of o.events as unknown[]) {
      const x = e as Record<string, unknown>
      if (!x || typeof x.id !== 'string' || typeof x.kind !== 'string' || typeof x.hlc !== 'string' || !('body' in x)) throw new FrameError('bad snap event')
      events.push({ id: x.id, kind: x.kind, hlc: x.hlc, body: x.body as Json })
    }
  }
  return { fields, events, state: data.subarray(4 + n) }
}
