// The sync engine (ADR-0005, ADR-0001 §5): push the outbox, pull into the inbox together with the cursor, apply the inbox.
// The three steps are separate transactions, so a crash between any two leaves a state the next round simply continues from.
import { EnvelopeError, FrameError, encodeEnvelope, parseEnvelope } from '@nevis/protocol'
import { applyEnvelope } from './apply'
import type { Store } from './store'

export interface PushResult { results: { op: string; seq: number; status: 'ok' | 'dup' | 'purged' }[]; head: number }
export interface PullOp { seq: number; by: string; rt: number; /** the envelope as JSON text */ env: string }
export interface PullResult { ops: PullOp[]; head: number; more: boolean }

/** The network, as the engine sees it. Real HTTP in production; the harness wraps it to inject faults. */
export interface Net {
  push(ws: string, envs: string[]): Promise<PushResult>
  pull(ws: string, after: number, limit: number): Promise<PullResult>
}

export class NetError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  constructor(status: number, code: string, retryable: boolean, message = code) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

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
  batch?: number
}

export interface CycleStats { pushed: number; dup: number; pulled: number; applied: number; held: number; quarantined: number }

export class SyncEngine {
  private readonly o: Required<Omit<EngineOptions, 'hooks'>> & { hooks: EngineHooks }
  constructor(o: EngineOptions) {
    this.o = { now: Date.now, batch: 500, hooks: {}, ...o }
  }

  /** Push everything pending, pull everything new, apply it. */
  async cycle(): Promise<CycleStats> {
    const s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0 }
    await this.push(s)
    await this.pull(s)
    await this.applyInbox(s)
    return s
  }

  async push(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0 }) {
    const { store, net, ws } = this.o
    for (;;) {
      const rows = await store.run(tx => tx.listOutbox(this.o.batch))
      if (!rows.length) return
      const res = await net.push(ws, rows.map(r => r.env))
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

  async pull(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0 }) {
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

  async applyInbox(s: CycleStats = { pushed: 0, dup: 0, pulled: 0, applied: 0, held: 0, quarantined: 0 }) {
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
            else { done.push(row.seq); s.applied++ }
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
