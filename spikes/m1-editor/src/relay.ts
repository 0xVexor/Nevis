// An in-memory relay between two Y.Docs. It can delay, drop-to-offline, duplicate and reorder updates, so that the
// editors see what two devices on a bad network see. The "wire" carries Yjs V1 updates and nothing else.
import * as Y from 'yjs'

export const REMOTE = Symbol('remote')
export type Side = 'A' | 'B'
interface Msg { update: Uint8Array; due: number }

export class Relay {
  readonly docs: Record<Side, Y.Doc>
  /** updates waiting to reach the other side, keyed by their SENDER */
  readonly queue: Record<Side, Msg[]> = { A: [], B: [] }
  delayMs = 0
  offline: Record<Side, boolean> = { A: false, B: false }
  duplicate = false
  /** an editor that is in the middle of an IME composition asks to hold remote updates (ADR-0003 §13) */
  holdWhile: Record<Side, () => boolean> = { A: () => false, B: () => false }
  holdMaxMs = 10000
  delivered = 0
  private heldSince: Record<Side, number | null> = { A: null, B: null }

  private readonly now: () => number
  constructor(a: Y.Doc, b: Y.Doc, now: () => number = () => Date.now()) {
    this.now = now
    this.docs = { A: a, B: b }
    for (const side of ['A', 'B'] as const) {
      this.docs[side].on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return
        this.queue[side].push({ update, due: this.now() + this.delayMs })
      })
    }
  }

  private target = (from: Side): Side => (from === 'A' ? 'B' : 'A')

  /** Delivers what is due. Offline senders and receivers keep their queue. Returns how many updates were applied. */
  tick(): number {
    let n = 0
    for (const from of ['A', 'B'] as const) {
      const to = this.target(from)
      if (this.offline[from] || this.offline[to]) continue
      if (this.holdWhile[to]()) {
        this.heldSince[to] ??= this.now()
        if (this.now() - this.heldSince[to]! < this.holdMaxMs) continue
      }
      this.heldSince[to] = null
      const q = this.queue[from]
      const ready = q.filter(m => m.due <= this.now())
      this.queue[from] = q.filter(m => m.due > this.now())
      for (const m of ready) {
        Y.applyUpdate(this.docs[to], m.update, REMOTE)
        n++
        if (this.duplicate) Y.applyUpdate(this.docs[to], m.update, REMOTE) // a second delivery must change nothing
      }
    }
    this.delivered += n
    return n
  }

  /** Deterministic stepping for the fuzzer: deliver a random subset, in random order, some of them twice. */
  deliverRandom(rng: () => number): number {
    let n = 0
    for (const from of ['A', 'B'] as const) {
      const to = this.target(from)
      const q = this.queue[from]
      if (!q.length || rng() < 0.4) continue
      const pick = q.filter(() => rng() < 0.6)
      this.queue[from] = q.filter(m => !pick.includes(m))
      pick.sort(() => rng() - 0.5)
      for (const m of pick) {
        Y.applyUpdate(this.docs[to], m.update, REMOTE)
        if (rng() < 0.2) Y.applyUpdate(this.docs[to], m.update, REMOTE)
        n++
      }
    }
    return n
  }

  /** Delivers everything, ignoring delay and offline flags. */
  flush() {
    for (let round = 0; round < 10 && (this.queue.A.length || this.queue.B.length); round++) {
      for (const from of ['A', 'B'] as const) {
        const q = this.queue[from]
        this.queue[from] = []
        for (const m of q) Y.applyUpdate(this.docs[this.target(from)], m.update, REMOTE)
      }
    }
  }

  pending = () => ({ A: this.queue.A.length, B: this.queue.B.length })
}
