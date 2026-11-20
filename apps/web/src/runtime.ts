// The sync runtime of one workspace in one tab: the IndexedDB store, the client (local writes), the engine (push/pull/apply), and the
// tab coordinator (one leader per workspace talks to the server, with a long-poll). Shared by the real app and the test lab.
import { Client, SyncEngine, TabCoordinator, httpNet, type ChangedMessage, type CycleStats } from '@nevis/core'
import { uuidv7 } from '@nevis/protocol'
import { IdbStore } from '@nevis/store-idb'
import { webChannel, webLocks } from './ports'

/** The schema version of this build (ADR-0002); a document from a newer one is not opened for editing. */
export const SV = 1

export interface RuntimeOptions {
  ws: string
  /** `'dev'` = the development token (tests); `null` = the signed-in cookie session. */
  token: string | null
  /** something worth redrawing happened (status, leader, errors) */
  onChange?: () => void
  /** the engine applied operations from the server (documents and lists may have changed) */
  onApplied?: (s: CycleStats) => void
  /** another tab of this browser committed */
  onRemoteChange?: (m: ChangedMessage) => void
}

export class SyncRuntime {
  readonly ws: string
  readonly store: IdbStore
  client!: Client
  engine!: SyncEngine
  coord!: TabCoordinator
  device = ''
  persisted: boolean | null = null
  lastError = ''
  lastSyncAt = 0
  private _offline = false
  private readonly o: RuntimeOptions
  private offOnline: (() => void) | null = null

  constructor(o: RuntimeOptions) {
    this.o = o
    this.ws = o.ws
    this.store = new IdbStore({ name: `nevis-${o.ws}`, onVersionChange: () => { this.lastError = 'a newer tab upgraded the database: reload'; this.coord?.stop(); this.o.onChange?.() } })
  }

  /** A switch for tests: refuse every request as if the network were down. */
  get offline() { return this._offline }
  set offline(v: boolean) { this._offline = v; if (!v) this.coord?.kick(); this.o.onChange?.() }

  async start() {
    this.device = await this.store.run(async tx => {
      let d = await tx.getMeta('deviceId')
      if (!d) { d = uuidv7(); await tx.setMeta('deviceId', d) }
      return d
    })
    // Asked in the background: Firefox may show the person a permission prompt, and the answer can take for ever. The app must
    // not wait for it (R2: persist() is a heuristic in Safari/Chrome and a prompt in Firefox).
    void Promise.resolve(navigator.storage?.persist?.()).then(v => { this.persisted = v ?? null; this.o.onChange?.() }, () => { this.persisted = null })
    const net = httpNet({ ...(this.o.token ? { token: this.o.token } : {}), offline: () => this._offline })
    this.client = new Client({ store: this.store, ws: this.ws, device: this.device, sv: SV })
    this.engine = new SyncEngine({ store: this.store, net, ws: this.ws, device: this.device, sv: SV })
    this.coord = new TabCoordinator({
      ws: this.ws, locks: webLocks, channel: webChannel(`nevis-${this.ws}`), intervalMs: 2000,
      cycle: async () => {
        const s = await this.engine.cycle()
        this.lastError = ''
        this.lastSyncAt = Date.now()
        if (s.applied) this.o.onApplied?.(s)
        if (s.applied || s.pushed) this.o.onChange?.()
        return s
      },
      idle: signal => this.engine.listen(signal),
      onLeaderChange: () => this.o.onChange?.(),
      onRemoteChange: m => { this.o.onRemoteChange?.(m); this.o.onChange?.() },
      onError: e => { this.lastError = String((e as Error).message ?? e); this.o.onChange?.() },
    })
    this.coord.start()
    // the browser says the network is back: try now instead of waiting out the backoff
    const online = () => this.coord.kick()
    addEventListener('online', online)
    this.offOnline = () => removeEventListener('online', online)
    this.o.onChange?.()
  }

  /** This tab wrote something: tell the other tabs, and sync soon. */
  written(info: { docs?: string[]; ents?: string[] } = {}) { this.coord.notifyLocalChange(info) }

  /** Stops syncing and releases the leader lock (sign-out, close). */
  stop() { this.offOnline?.(); this.coord?.stop() }
}
