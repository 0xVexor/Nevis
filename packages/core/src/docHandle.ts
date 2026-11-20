// An open document body (ADR-0003 §10-12). One Y.Doc per open document in this tab.
//
// Three streams meet here and must never be confused:
//  - LOCAL updates (made by the editor): collected, merged and written every `throttleMs` (a THROTTLE, not a debounce: continuous
//    typing must still reach the disk every 300 ms) in ONE transaction with the outbox row;
//  - STORE updates (what the sync engine or another tab wrote): applied with the REMOTE origin: they go to the editor only, never
//    to the outbox again, and the undo manager (which tracks the editor's own origin) never sees them;
//  - `flush()` is public so that the page can call it on `visibilitychange`/`pagehide`/close. This file has no DOM.
import * as Y from 'yjs'
import type { Client } from './client'

/** The origin of updates that came from the store. */
export const REMOTE = Symbol('nevis-remote')

export type Cancel = () => void
export interface DocHandleOptions {
  client: Client
  doc: string
  throttleMs?: number
  /** a timer, replaceable in tests */
  schedule?: (fn: () => void, ms: number) => Cancel
  /** after local updates were written: tell the other tabs and kick the sync */
  onLocalWrite?: (doc: string) => void
  onError?: (e: unknown) => void
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export class DocHandle {
  readonly ydoc = new Y.Doc({ gc: true })
  readonly doc: string
  private readonly client: Client
  private readonly throttleMs: number
  private readonly schedule: (fn: () => void, ms: number) => Cancel
  private readonly onLocalWrite?: (doc: string) => void
  private readonly onError?: (e: unknown) => void
  private pending: Uint8Array[] = []
  private cancelTimer: Cancel | null = null
  private writing: Promise<void> = Promise.resolve()
  private lastK = 0
  private lastState: Uint8Array | null = null
  private closed = false
  /** true when the document holds changes from a newer schema this client cannot read (ADR-0003 §6): do not edit it. */
  needsUpdate = false

  private constructor(o: DocHandleOptions) {
    this.client = o.client
    this.doc = o.doc
    this.throttleMs = o.throttleMs ?? 300
    this.schedule = o.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) })
    this.onLocalWrite = o.onLocalWrite
    this.onError = o.onError
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.needsUpdate) return
      this.pending.push(u)
      if (!this.cancelTimer) this.cancelTimer = this.schedule(() => { this.cancelTimer = null; void this.flush() }, this.throttleMs)
    })
  }

  static async open(o: DocHandleOptions): Promise<DocHandle> {
    const h = new DocHandle(o)
    await h.refresh()
    return h
  }

  /** Reads what the store holds for this document and applies what is new (also the first load). Returns whether the content changed. */
  async refresh(): Promise<boolean> {
    const { state, tail } = await this.client.store.run(async tx => ({ state: await tx.getDocState(this.doc), tail: await tx.listDocUpdates(this.doc) }))
    this.needsUpdate = (state?.maxSv ?? 0) > this.client.sv
    let changed = false
    const seen = () => { changed = true }
    this.ydoc.on('update', seen)
    try {
      this.ydoc.transact(() => {
        if (state?.state && (!this.lastState || !sameBytes(this.lastState, state.state))) { Y.applyUpdate(this.ydoc, state.state, REMOTE); this.lastState = state.state }
        for (const u of tail) if (u.k > this.lastK) Y.applyUpdate(this.ydoc, u.upd, REMOTE)
      }, REMOTE)
    } finally {
      this.ydoc.off('update', seen)
    }
    if (tail.length) this.lastK = Math.max(this.lastK, tail[tail.length - 1]!.k)
    return changed
  }

  /** Writes what the editor changed since the last write. Safe to call at any time and from several places. */
  flush(): Promise<void> {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.writing = this.writing.then(() => this.writeNow())
    return this.writing
  }

  private async writeNow(): Promise<void> {
    if (!this.pending.length || this.needsUpdate) return
    const batch = this.pending
    this.pending = []
    try {
      await this.client.writeYUpdate(this.doc, batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch))
      this.onLocalWrite?.(this.doc)
    } catch (e) {
      this.pending = [...batch, ...this.pending] // nothing was written: keep it and try again soon
      if (!this.closed && !this.cancelTimer) this.cancelTimer = this.schedule(() => { this.cancelTimer = null; void this.flush() }, Math.max(this.throttleMs, 1000))
      this.onError?.(e)
    }
  }

  /** How many local updates are waiting to be written (for the "not saved yet" indicator). */
  get unsaved(): number { return this.pending.length }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    this.ydoc.destroy()
  }
}
