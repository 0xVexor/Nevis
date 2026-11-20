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
