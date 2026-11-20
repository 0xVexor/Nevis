// A device whose clock ran ahead made ops with HLCs in the future; the server refuses a whole batch with such an op
// (`422 clock_ahead`, ADR-0005). Nothing is lost: the ops are still in the outbox. Once the clock is right the engine rebuilds
// them: same content, a fresh op id and a fresh HLC, and the local registers and events that still carry the old HLC are moved
// to the new one, all in ONE transaction. Those ops never left the device, so no other device has seen the old ids or HLCs.
import { FRAME, MAX_SKEW_MS, b64urlEncode, decodeEvt, decodeFrame, decodeRec, b64urlDecode, encodeEnvelope, encodeEvt, encodeRec, parseEnvelope, parseHlc, uuidv7, formatHlc } from '@nevis/protocol'
import { nextHlc } from './clock'
import type { Store } from './store'

/** An op is "in the future" when its HLC is more than this far ahead of the device's (now correct) clock. */
export const FUTURE_MARGIN_MS = MAX_SKEW_MS / 2

export async function rebuildFutureOps(store: Store, device: string, now: number, newId: () => string = uuidv7): Promise<number> {
  return store.run(async tx => {
    const rows = await tx.listOutbox(Number.MAX_SAFE_INTEGER)
    const future = rows.filter(r => {
      const h = parseHlc(parseEnvelope(r.env).t)
      return !!h && h.ms > now + FUTURE_MARGIN_MS
    })
    if (!future.length) return 0
    // the clock goes back to the right time, inside this same transaction
    await tx.setMeta('hlc', formatHlc({ ms: now, counter: 0 }, device))
    for (const row of future) {
      const env = parseEnvelope(row.env)
      const oldH = env.t
      const h = await nextHlc(tx, device, now)
      let frame = decodeFrame(b64urlDecode(env.p))
      let data = frame.data
      if (frame.kind === FRAME.rec) {
        const rec = decodeRec(frame.data)
        for (const f of Object.keys(rec.set)) await tx.rekeyField(env.doc, f, oldH, h)
        if (rec.kind !== undefined) await tx.rekeyField(env.doc, '$kind', oldH, h)
        data = encodeRec({ ...rec, h }).subarray(1)
      } else if (frame.kind === FRAME.evt) {
        const e = decodeEvt(frame.data)
        await tx.rekeyEvent(e.id, h)
        data = encodeEvt({ ...e, h }).subarray(1)
      }
      const framed = new Uint8Array(1 + data.length)
      framed[0] = frame.kind
      framed.set(data, 1)
      const rebuilt = encodeEnvelope({ ...env, op: newId(), t: h, p: b64urlEncode(framed) })
      await tx.deleteOutbox([row.op])
      await tx.addOutbox({ op: parseEnvelope(rebuilt).op, env: rebuilt, created: row.created })
    }
    return future.length
  })
}
