// Hybrid logical clock (ADR-0002). The wire form is a fixed-width string so that comparing two of them as plain strings
// IS the total order: "<ms: 12 hex>-<counter: 4 hex>-<deviceId>". The device id is kept whole to break ties.
export interface HlcState { ms: number; counter: number }

export const HLC_RE = /^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
/** A device whose clock is more than this far ahead of the server is refused (`422 clock_ahead`). */
export const MAX_SKEW_MS = 10 * 60 * 1000
const MAX_COUNTER = 0xffff

export const formatHlc = (s: HlcState, device: string): string => `${s.ms.toString(16).padStart(12, '0')}-${s.counter.toString(16).padStart(4, '0')}-${device}`

export function parseHlc(s: string): { ms: number; counter: number; device: string } | null {
  const m = HLC_RE.exec(s)
  return m ? { ms: parseInt(m[1]!, 16), counter: parseInt(m[2]!, 16), device: m[3]! } : null
}

export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const norm = (s: HlcState): HlcState => (s.counter > MAX_COUNTER ? { ms: s.ms + 1, counter: 0 } : s)

/** A local event or a send: never goes back, even if the wall clock does. */
export function hlcSend(prev: HlcState, now: number): HlcState {
  const ms = Math.max(prev.ms, now)
  return norm({ ms, counter: ms === prev.ms ? prev.counter + 1 : 0 })
}

/** Receiving a remote timestamp: the result is greater than both the local state and the remote one. */
export function hlcRecv(prev: HlcState, remote: { ms: number; counter: number }, now: number): HlcState {
  const ms = Math.max(prev.ms, remote.ms, now)
  let counter: number
  if (ms === prev.ms && ms === remote.ms) counter = Math.max(prev.counter, remote.counter) + 1
  else if (ms === prev.ms) counter = prev.counter + 1
  else if (ms === remote.ms) counter = remote.counter + 1
  else counter = 0
  return norm({ ms, counter })
}
