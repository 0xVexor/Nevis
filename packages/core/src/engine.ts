// The sync engine (ADR-0005, ADR-0001 §5): push the outbox, pull into the inbox together with the cursor, apply the inbox.
// The three steps are separate transactions, so a crash between any two leaves a state the next round simply continues from.
import { EnvelopeError, FrameError, encodeEnvelope, parseEnvelope } from '@nevis/protocol'
import { applyEnvelope } from './apply'
import { rebuildFutureOps } from './clockRepair'
import type { Store, OutboxRow } from './store'

export interface PushResult { results: { op: string; seq: number; status: 'ok' | 'dup' | 'purged' }[]; head: number }
export interface PullOp { seq: number; by: string; rt: number; /** the envelope as JSON text */ env: string }
export interface PullResult { ops: PullOp[]; head: number; more: boolean }

/** The network, as the engine sees it. Real HTTP in production; the harness wraps it to inject faults. */
export interface Net {
  push(ws: string, envs: string[]): Promise<PushResult>
  /** `wait` (seconds, 0..25): hold the request until something newer than `after` exists. `signal` cancels it. */
  pull(ws: string, after: number, limit: number, opts?: { wait?: number; signal?: AbortSignal }): Promise<PullResult>
}

export class NetError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  /** the rest of the server's error object (`received` of an out-of-order piece, `maxBytes` of a file that is too large) */
  readonly details: Record<string, unknown>
  constructor(status: number, code: string, retryable: boolean, message = code, details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

/** The outbox gate (ADR-0005): which rows may be sent now. Rows that refer to an attachment the server does not have yet are held back,
 *  and so are the LATER rows of the same document (a peer must never receive an update whose dependency is missing). Other
 *  documents go on. The gate also asks the server whether a blob it believes uploaded is still there (a long-offline device may have
 *  seen it collected) and holds the row if not. */
export interface OutboxGate {
  ready(rows: OutboxRow[]): Promise<OutboxRow[]>
}

/** The server said THIS op is invalid for good (envelope validation), not that the request or the app version is wrong. */
const isBadOp = (e: NetError) => e.status === 400 && e.code === 'bad_envelope'

/** Test hooks that let the harness stop the engine at the awkward moments (a crash). */
export interface EngineHooks {
  afterPush?: () => void | Promise<void>
  afterPull?: () => void | Promise<void>
}

export interface EngineOptions {
  store: Store
  net: Net
  ws: string
  device: string
  sv: number
  now?: () => number
  hooks?: EngineHooks
  /** attachments: rows that point at a file the server lacks are held back (absent = no attachments in this client) */
  gate?: OutboxGate
  batch?: number
  /** a batch stops before its envelopes exceed this many characters (the server refuses a body over 4 MB with a permanent 413) */
  maxBatchChars?: number
}

export interface CycleStats { pushed: number; dup: number; pulled: number; applied: number; held: number; quarantined: number; /** ops the server refused for good (moved to quarantine, not retried) */ rejected: number
  /** documents whose ops were applied this round (derived indexes refresh these) */
  docs?: string[] }

export class SyncEngine {
  private readonly o: Required<Omit<EngineOptions, 'hooks' | 'gate'>> & { hooks: EngineHooks; gate?: OutboxGate }
  constructor(o: EngineOptions) {
    this.o = { now: Date.now, batch: 500, maxBatchChars: 3_000_000, hooks: {}, ...o }
  }

  /** Push everything pending, pull everything new, apply it. */
  async cycle(): Promise<CycleStats> {
    const s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0, rejected: 0 }
    await this.repairClock()
    await this.push(s)
    await this.pull(s)
    await this.applyInbox(s)
    return s
  }

  /** Parks in a long-poll until the server has something newer than the cursor (or `signal` aborts, or 25 s pass). Returns true if there is
   *  news. It stores nothing: the next `cycle` pulls it. A write on this device aborts it so that the push is not held up. */
  async listen(signal: AbortSignal): Promise<boolean> {
    const { store, net, ws } = this.o
    const after = Number((await store.run(tx => tx.getMeta('cursor'))) ?? 0)
    try {
      const page = await net.pull(ws, after, 1, { wait: 25, signal })
      return page.ops.length > 0
    } catch (e) {
      if (signal.aborted) return false
      throw e
    }
  }

  /** After a `clock_ahead` refusal: once the device clock is right again, rebuild the ops that carry a future HLC. */
  async repairClock(): Promise<number> {
    const { store, device, now } = this.o
    if ((await store.run(tx => tx.getMeta('clockAhead'))) !== '1') return 0
    const n = await rebuildFutureOps(store, device, now())
    // nothing is left in the future relative to a correct clock: the flag goes. (If the clock is STILL ahead, the ops are not
    // in the future relative to it, the push is refused again and the flag comes back: the person has to fix the clock.)
    await store.run(tx => tx.setMeta('clockAhead', '0'))
    return n
  }

  async push(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0, rejected: 0 }) {
    const { store, net, ws } = this.o
    for (;;) {
      let all = await store.run(tx => tx.listOutbox(this.o.batch))
      if (this.o.gate && all.length) {
        // held rows must not starve the ones behind them: look further down the outbox when the first window yielded nothing to send
        let window = this.o.batch
        let ready = await this.o.gate.ready(all)
        while (!ready.length && all.length >= window && window < 8 * this.o.batch) {
          window *= 4
          all = await store.run(tx => tx.listOutbox(window))
          ready = await this.o.gate.ready(all)
        }
        all = ready.slice(0, this.o.batch)
      }
      // bounded by SIZE as well as by count: three legal 1.4M ops together are over the 4 MB the server accepts, and a 413 is permanent
      let chars = 0
      const rows = all.filter((r, i) => { chars += r.env.length; return i === 0 || chars <= this.o.maxBatchChars })
      if (!rows.length) return
      let res: PushResult
      try {
        res = await net.push(ws, rows.map(r => r.env))
      } catch (e) {
        // the server refused the batch because this device's clock is ahead: remember it, keep every op, repair when the clock is right
        if (e instanceof NetError && e.code === 'clock_ahead') await store.run(tx => tx.setMeta('clockAhead', '1'))
        // `bad_envelope` means SOME op of the batch can never be accepted: without this, that one op blocks the whole outbox for ever.
        // Only that code: `bad_request` is about the batch, 426 (`upgrade_required`, sv below the workspace minSv) means the app must be
        // updated and the ops are KEPT, 409/413/422 are other situations. None of those may drain the outbox into quarantine.
        if (e instanceof NetError && isBadOp(e) && rows.length > 0) { await this.pushOneByOne(rows, s); continue }
        throw e
      }
      const sent = new Set(rows.map(r => r.op))
      const done: string[] = []
      for (const r of res.results) {
        if (!sent.has(r.op)) continue
        done.push(r.op)
        if (r.status === 'dup') s.dup++
        else s.pushed++
      }
      if (done.length !== rows.length) throw new NetError(502, 'incomplete_push_answer', true)
      await this.o.hooks.afterPush?.()
      // the row goes only after the server has answered with a seq for it
      await store.run(tx => tx.deleteOutbox(done))
    }
  }

  /** After a batch was refused for good: push the ops one at a time. An op the server refuses for good (400, not retryable) goes to
   *  quarantine with the reason and leaves the outbox, so the ops behind it are sent. The local state keeps its change; the device
   *  and the server differ by it, and `rejected` makes that visible. Any other failure stops the round as usual. */
  private async pushOneByOne(rows: { op: string; env: string }[], s: CycleStats) {
    const { store, net, ws } = this.o
    for (const r of rows) {
      try {
        const res = await net.push(ws, [r.env])
        if (res.results.some(x => x.op === r.op)) { res.results.some(x => x.status === 'dup') ? s.dup++ : s.pushed++; await store.run(tx => tx.deleteOutbox([r.op])) }
        else throw new NetError(502, 'incomplete_push_answer', true)
      } catch (e) {
        if (!(e instanceof NetError && isBadOp(e))) throw e
        await store.run(async tx => {
          const n = Number((await tx.getMeta('rejectedCount')) ?? 0) + 1
          await tx.setMeta('rejectedCount', String(n))
          await tx.addQuarantine({ seq: -n, env: r.env, reason: `refused by the server: ${e.code}: ${e.message}` }) // negative seq: never collides with a server seq
          await tx.deleteOutbox([r.op])
        })
        s.rejected++
      }
    }
  }

  async pull(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0, rejected: 0 }) {
    const { store, net, ws } = this.o
    for (;;) {
      const after = Number((await store.run(tx => tx.getMeta('cursor'))) ?? 0)
      const page = await net.pull(ws, after, 1000)
      if (page.ops.length) {
        await store.run(async tx => {
          let max = after
          for (const op of page.ops) {
            await tx.putInbox({ seq: op.seq, env: op.env })
            max = Math.max(max, op.seq)
          }
          await tx.setMeta('cursor', String(max)) // the cursor moves in the same transaction that stores what it covers
        })
        s.pulled += page.ops.length
        await this.o.hooks.afterPull?.()
      }
      if (!page.more) return
    }
  }

  async applyInbox(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0, rejected: 0 }) {
    const { store, device, sv } = this.o
    let after = 0
    for (;;) {
      const rows = await store.run(tx => tx.listInbox(after, 200))
      if (!rows.length) return
      after = rows[rows.length - 1]!.seq
      await store.run(async tx => {
        const done: number[] = []
        for (const row of rows) {
          try {
            const env = parseEnvelope(row.env)
            const r = await applyEnvelope(tx, env, { device, sv, now: this.o.now() })
            if (r === 'held') s.held++ // stays in the inbox until this client understands its schema
            else { done.push(row.seq); s.applied++; if (r === 'applied') (s.docs ??= []).includes(env.doc) || s.docs.push(env.doc) }
          } catch (e) {
            if (!(e instanceof EnvelopeError || e instanceof FrameError || e instanceof SyntaxError)) throw e
            await tx.addQuarantine({ seq: row.seq, env: row.env, reason: String((e as Error).message).slice(0, 200) })
            done.push(row.seq)
            s.quarantined++
          }
        }
        await tx.deleteInbox(done)
      })
    }
  }
}

export { encodeEnvelope }
