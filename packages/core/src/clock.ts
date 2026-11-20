// The device's HLC, kept in `meta.hlc` and advanced INSIDE the transaction of the write that uses it, so a restart can never
// hand out a timestamp that was already used (ADR-0002).
import { formatHlc, hlcRecv, hlcSend, parseHlc, type HlcState } from '@nevis/protocol'
import type { Tx } from './store'

async function load(tx: Tx): Promise<HlcState> {
  const s = await tx.getMeta('hlc')
  const p = s ? parseHlc(s) : null
  return p ? { ms: p.ms, counter: p.counter } : { ms: 0, counter: 0 }
}

/** The next timestamp for something this device does. */
export async function nextHlc(tx: Tx, device: string, now: number): Promise<string> {
  const s = hlcSend(await load(tx), now)
  const h = formatHlc(s, device)
  await tx.setMeta('hlc', h)
  return h
}

/** Takes in the timestamp of an op that came from elsewhere. */
export async function observeHlc(tx: Tx, device: string, remote: string, now: number): Promise<void> {
  const r = parseHlc(remote)
  if (!r) return
  const s = hlcRecv(await load(tx), r, now)
  await tx.setMeta('hlc', formatHlc(s, device))
}
