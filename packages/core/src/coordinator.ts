// Many tabs, one syncer (ADR-0007 §5). Every tab runs the core and writes to the local store. A Web Lock named
// `nevis-sync-<ws>` picks the LEADER; only the leader talks to the network. When any tab commits it broadcasts a small
// `changed` message so that the other tabs reload what they show, and the leader syncs soon. The browser releases the lock
// when the leader tab closes or crashes, so the next waiting tab takes over by itself.
//
// Everything platform-specific is a port, so this file has no DOM and runs the same in Node (tests) and in a worker.

export interface LockPort {
  /** Waits for the exclusive lock `name`, runs `held` while holding it, releases it when `held` settles or `signal` aborts. */
  request(name: string, signal: AbortSignal, held: () => Promise<void>): Promise<void>
}

export interface ChannelPort {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): () => void
  close(): void
}

export interface ChangedMessage { type: 'changed'; from: string; docs?: string[]; ents?: string[] }

export interface CoordinatorOptions {
  ws: string
  locks: LockPort
  channel: ChannelPort
  /** One sync round (the engine's `cycle`). */
  cycle: () => Promise<unknown>
  /** How often the leader syncs when nothing kicks it (the server has no long-poll until M4). */
  intervalMs?: number
  /** Parks until the server has news (a long-poll); called with a signal that is aborted when this tab writes. Without it the leader polls. */
  idle?: (signal: AbortSignal) => Promise<unknown>
  onLeaderChange?: (leader: boolean) => void
  /** Another tab committed: reload what this tab shows. */
  onRemoteChange?: (m: ChangedMessage) => void
  /** A sync round failed (network trouble is normal; the leader retries with backoff). */
  onError?: (e: unknown) => void
  /** This tab has no usable shared state any more (e.g. the database was upgraded elsewhere). */
  onStop?: () => void
}

const MAX_BACKOFF_MS = 30_000

export class TabCoordinator {
  readonly tabId: string = Math.random().toString(36).slice(2) + Date.now().toString(36)
  private readonly o: Required<Pick<CoordinatorOptions, 'intervalMs'>> & CoordinatorOptions
  private abort: AbortController | null = null
  private leader = false
  private wake: (() => void) | null = null
  private kicked = false
  private offMessage: (() => void) | null = null
  private failures = 0
  rounds = 0

  constructor(o: CoordinatorOptions) {
    this.o = { intervalMs: 2000, ...o }
  }

  get isLeader() { return this.leader }

  start() {
    if (this.abort) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.offMessage = this.o.channel.onMessage(m => {
      const msg = m as ChangedMessage
      if (!msg || msg.type !== 'changed' || msg.from === this.tabId) return
      this.o.onRemoteChange?.(msg)
      this.kick() // if this tab leads, push what the other tab wrote
    })
    void this.o.locks.request(`nevis-sync-${this.o.ws}`, signal, () => this.lead(signal)).catch(e => {
      if (!signal.aborted) this.o.onError?.(e)
    })
  }

  stop() {
    this.abort?.abort()
    this.abort = null
    this.offMessage?.()
    this.offMessage = null
    this.wake?.()
    this.o.channel.close()
    this.o.onStop?.()
  }

  /** This tab committed a write: tell the other tabs, and sync soon if this tab leads. */
  notifyLocalChange(info: { docs?: string[]; ents?: string[] } = {}) {
    this.o.channel.post({ type: 'changed', from: this.tabId, ...info } satisfies ChangedMessage)
    this.kick()
  }

  /** Sync as soon as possible (a no-op in a tab that is not the leader). */
  kick() {
    this.kicked = true
    this.wake?.()
  }

  private async lead(signal: AbortSignal) {
    this.leader = true
    this.o.onLeaderChange?.(true)
    try {
      while (!signal.aborted) {
        try {
          await this.o.cycle()
          this.rounds++
          this.failures = 0
        } catch (e) {
          this.failures++
          this.o.onError?.(e)
        }
        if (signal.aborted) break
        const wait = this.failures ? Math.min(MAX_BACKOFF_MS, this.o.intervalMs * 2 ** (this.failures - 1)) : this.o.intervalMs
        if (!this.kicked && !this.failures && this.o.idle) {
          // long-poll: a local write (kick) or a stop aborts it at once, so a push is never held up behind the wait
          const poll = new AbortController()
          const abort = () => poll.abort()
          this.wake = abort
          signal.addEventListener('abort', abort, { once: true })
          const t0 = Date.now()
          try { await this.o.idle(poll.signal) } catch (e) { this.failures++; this.o.onError?.(e) }
          signal.removeEventListener('abort', abort)
          // a server that answers at once with no news must not make a busy loop
          if (!this.kicked && !signal.aborted && Date.now() - t0 < 50) await new Promise<void>(r => setTimeout(r, this.o.intervalMs))
        } else if (!this.kicked) await new Promise<void>(res => {
          const t = setTimeout(done, wait)
          function done() { clearTimeout(t); res() }
          this.wake = done
          signal.addEventListener('abort', done, { once: true })
        })
        this.wake = null
        this.kicked = false
      }
    } finally {
      this.leader = false
      this.o.onLeaderChange?.(false)
    }
  }
}
