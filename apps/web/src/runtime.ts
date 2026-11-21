// The sync runtime of one workspace in one tab: the IndexedDB store, the client (local writes), the engine (push/pull/apply), and the
// tab coordinator (one leader per workspace talks to the server, with a long-poll). Shared by the real app and the test lab.
import { BlobSync, Client, SyncEngine, TabCoordinator, httpBlobNet, httpNet, sha256Hex, type BlobStatus, type BlobStore, type ChangedMessage, type CycleStats, type Store } from '@nevis/core'
import type { AttachmentsPort } from '@nevis/editor'
import { SV, uuidv7 } from '@nevis/protocol'
import { IdbBlobStore, IdbStore } from '@nevis/store-idb'
import { desktopBlobNet, desktopFetch, isDesktop, openDesktopBlobs, openDesktopStore } from './desktop'
import { webChannel, webLocks } from './ports'


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

/** The largest attachment this app offers to store (the server's own limit may be lower: it then says so and the file stays local). */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export class SyncRuntime {
  readonly ws: string
  readonly store: Store
  readonly blobs: BlobStore
  blobSync!: BlobSync
  /** what the editor is given: files are kept here first, shown from here or from the server */
  attachments!: AttachmentsPort
  private readonly availableListeners = new Set<() => void>()
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
    // Desktop: SQLite in Rust (one window, so no other tab can upgrade it). Web: IndexedDB.
    this.store = isDesktop
      ? openDesktopStore(o.ws)
      : new IdbStore({ name: `nevis-${o.ws}`, onVersionChange: () => { this.lastError = 'a newer tab upgraded the database: reload'; this.coord?.stop(); this.o.onChange?.() } })
    // Attachments: their own database on the web (large files never share a transaction with the sync tables), files + SQLite on desktop.
    this.blobs = isDesktop ? openDesktopBlobs(o.ws) : new IdbBlobStore({ name: `nevis-${o.ws}-blobs` })
  }

  /** upload / quota state of the attachments, for the status line */
  blobStatus(): BlobStatus { return this.blobSync?.status() ?? { pending: 0, uploading: false, sent: 0, total: 0, error: '' } }
  private tellAvailable() { for (const f of [...this.availableListeners]) f() }

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
    if (isDesktop) this.persisted = true // a file in the app data folder: the browser cannot evict it
    else void Promise.resolve(navigator.storage?.persist?.()).then(v => { this.persisted = v ?? null; this.o.onChange?.() }, () => { this.persisted = null })
    const net = httpNet({ ...(this.o.token ? { token: this.o.token } : {}), ...(isDesktop ? { fetch: desktopFetch } : {}), offline: () => this._offline })
    const blobNet = isDesktop ? desktopBlobNet(() => this._offline) : httpBlobNet({ ...(this.o.token ? { token: this.o.token } : {}), offline: () => this._offline })
    this.blobSync = new BlobSync({ ws: this.ws, blobs: this.blobs, net: blobNet, onChange: () => this.o.onChange?.(), onUploaded: () => this.coord?.kick() })
    this.client = new Client({ store: this.store, ws: this.ws, device: this.device, sv: SV, blobs: this.blobs })
    this.engine = new SyncEngine({ store: this.store, net, ws: this.ws, device: this.device, sv: SV, gate: this.blobSync })
    this.attachments = {
      maxBytes: MAX_ATTACHMENT_BYTES,
      add: async (file, name, mime) => {
        const hash = await sha256Hex(file)
        try { await this.blobs.put(hash, file, mime) } catch (e) {
          const quota = e instanceof DOMException && e.name === 'QuotaExceededError'
          throw Object.assign(new Error(quota ? 'storage full' : String((e as Error)?.message ?? e)), { code: quota ? 'storage_full' : 'failed' })
        }
        this.coord?.notifyLocalChange() // the leader (maybe another tab) uploads it; the op that will name it waits for that (the outbox gate)
        this.o.onChange?.()
        return { blob: hash, mime, size: file.size, name }
      },
      open: (hash, mime) => this.blobSync.fetch(hash, mime).then(b => b ?? null),
      subscribe: cb => { this.availableListeners.add(cb); return () => this.availableListeners.delete(cb) },
    }
    this.coord = new TabCoordinator({
      ws: this.ws, locks: webLocks, channel: webChannel(`nevis-${this.ws}`), intervalMs: 2000,
      cycle: async () => {
        // files: upload what waits (in the background: a 50 MB file must not stop pulling, and it must be tried even while a sync round
        // fails, e.g. offline, so that the status says what waits)
        void this.blobSync.uploadPending().catch(e => { this.lastError = String((e as Error).message ?? e) })
        const s = await this.engine.cycle()
        await this.blobSync.reportRefs(this.store).catch(() => undefined)
        if (s.applied || s.pulled) this.tellAvailable()
        this.lastError = s.rejected ? `${s.rejected} change(s) were refused by the server and could not be sent (kept in quarantine)` : ''
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
