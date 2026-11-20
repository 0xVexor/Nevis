// Applying one op to the local state. Every branch is idempotent and order-independent (registers: last HLC wins; events:
// insert if absent; Yjs: commutative), so a duplicate, a late or a reordered op changes nothing.
import { FRAME, FrameError, b64urlDecode, decodeEvt, decodeFrame, decodeRec, type Envelope } from '@nevis/protocol'
import { observeHlc } from './clock'
import { compactDoc } from './docs'
import type { Tx } from './store'

export const KIND_FIELD = '$kind'

export type Applied = 'applied' | 'held' | 'quarantined'

/** `sv` is this client's schema version: an op from a newer schema is held, not applied (ADR-0002). */
export async function applyEnvelope(tx: Tx, env: Envelope, ctx: { device: string; sv: number; now: number }): Promise<Applied> {
  if (env.sv > ctx.sv) {
    await tx.bumpMaxSv(env.doc, env.sv)
    return 'held'
  }
  const p = b64urlDecode(env.p)
  const frame = decodeFrame(p)
  switch (frame.kind) {
    case FRAME.rec: {
      const rec = decodeRec(frame.data)
      if (rec.kind !== undefined) await tx.putFieldIfNewer(env.doc, KIND_FIELD, JSON.stringify(rec.kind), rec.h)
      for (const [f, v] of Object.entries(rec.set)) await tx.putFieldIfNewer(env.doc, f, JSON.stringify(v), rec.h)
      break
    }
    case FRAME.yupd:
      await tx.appendDocUpdate(env.doc, frame.data)
      await compactDoc(tx, env.doc)
      break
    case FRAME.evt: {
      const e = decodeEvt(frame.data)
      await tx.putEvent({ id: e.id, ent: env.doc, kind: e.kind, hlc: e.h, body: JSON.stringify(e.body) })
      break
    }
    default:
      throw new FrameError(`frame kind ${frame.kind} is not supported yet`)
  }
  await observeHlc(tx, ctx.device, env.t, ctx.now)
  return 'applied'
}
