// The lab: a notes list over the real core, the real IndexedDB store, the real Go server, and several tabs.
import { Client, SyncEngine, TabCoordinator, httpNet, projectStore, type Projection } from '@nevis/core'
import { uuidv7 } from '@nevis/protocol'
import { IdbStore } from '@nevis/store-idb'
import { webChannel, webLocks } from './ports'

export const DEFAULT_WS = '019a8f3c-0000-7000-8000-0000000000a1'

export interface Note { id: string; title: string; count: number }
export interface Status {
  ws: string
  device: string
  leader: boolean
  outbox: number
  inbox: number
  cursor: number
  persisted: boolean | null
  usage: number | null
  quota: number | null
  offline: boolean
  rounds: number
  lastError: string
  notes: number
}

export class Lab {
  readonly ws: string
  readonly store: IdbStore
  client!: Client
  engine!: SyncEngine
  coord!: TabCoordinator
  device = ''
  offline = false
  persisted: boolean | null = null
  lastError = ''
  private listeners = new Set<() => void>()

  /** `'dev'` = the development token (tests); `null` = the signed-in cookie session. */
  private readonly token: string | null

  constructor(ws: string, token: string | null = 'dev') {
    this.token = token
    this.ws = ws
    this.store = new IdbStore({ name: `nevis-${ws}`, onVersionChange: () => { this.lastError = 'a newer tab upgraded the database: reload'; this.coord?.stop(); this.emit() } })
  }

  async start() {
    this.device = (await this.store.run(async tx => {
      let d = await tx.getMeta('deviceId')
      if (!d) { d = uuidv7(); await tx.setMeta('deviceId', d) }
      return d
    }))
    // Asked in the background: Firefox may show the person a permission prompt, and the answer can take for ever. The app must
    // not wait for it (R2: persist() is a heuristic in Safari/Chrome and a prompt in Firefox).
    void Promise.resolve(navigator.storage?.persist?.()).then(v => { this.persisted = v ?? null; this.emit() }, () => { this.persisted = null })
    const net = httpNet({ ...(this.token ? { token: this.token } : {}), offline: () => this.offline })
    this.client = new Client({ store: this.store, ws: this.ws, device: this.device, sv: 1 })
    this.engine = new SyncEngine({ store: this.store, net, ws: this.ws, device: this.device, sv: 1 })
    this.coord = new TabCoordinator({
      ws: this.ws, locks: webLocks, channel: webChannel(`nevis-${this.ws}`), intervalMs: 2000,
      cycle: async () => { const s = await this.engine.cycle(); this.lastError = ''; if (s.applied || s.pushed) this.emit(); return s },
      onLeaderChange: () => this.emit(),
      onRemoteChange: () => this.emit(),
      onError: e => { this.lastError = String((e as Error).message ?? e); this.emit() },
    })
    this.coord.start()
    this.emit()
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => void this.listeners.delete(fn) }
  private emit() { for (const f of this.listeners) f() }

  private async written() { this.coord.notifyLocalChange(); this.emit() }

  async notes(): Promise<Note[]> {
    return this.store.run(async tx => {
      const out: Note[] = []
      for (const ent of await tx.entities()) {
        const f = await tx.entityFields(ent)
        if (f.$kind && JSON.parse(f.$kind.val) === 'note') out.push({ id: ent, title: f.title ? JSON.parse(f.title.val) : '', count: f.count ? JSON.parse(f.count.val) : 0 })
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : 1))
    })
  }

  async newNote(title = 'یادداشت تازه') { const id = uuidv7(); await this.client.setFields(id, { title, count: 0 }, 'note'); await this.written(); return id }
  async editTitle(id: string, title: string) { await this.client.setFields(id, { title }); await this.written() }
  async createNotes(n: number) { for (let i = 0; i < n; i++) await this.newNote(`یادداشت ${i + 1}`) }

  /** `+1` to every note, one write after another (each is its own committed transaction). */
  async plusOneAll() {
    for (const n of await this.notes()) { await this.client.setFields(n.id, { count: n.count + 1 }); await this.written() }
  }

  /** Writes `count = r` to every note for r = 1..rounds. The crash test closes the page in the middle of this. */
  async burst(rounds: number) {
    const ids = (await this.notes()).map(n => n.id)
    for (let r = 1; r <= rounds; r++) for (const id of ids) { await this.client.setFields(id, { count: r }); this.coord.notifyLocalChange() }
  }

  /** Test data that is NOT synced: random bytes in a separate database, to put the origin under storage pressure. */
  async fillJunk(mb: number) {
    const db = await new Promise<IDBDatabase>((ok, bad) => {
      const r = indexedDB.open('nevis-junk', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('junk', { autoIncrement: true })
      r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error)
    })
    const chunk = new Uint8Array(1024 * 1024)
    for (let i = 0; i < mb; i++) {
      for (let o = 0; o < chunk.length; o += 65536) crypto.getRandomValues(chunk.subarray(o, o + 65536))
      await new Promise<void>((ok, bad) => { const t = db.transaction('junk', 'readwrite'); t.objectStore('junk').add(chunk.slice()); t.oncomplete = () => ok(); t.onerror = () => bad(t.error) })
    }
    db.close()
  }

  async status(): Promise<Status> {
    const [p, notes] = await Promise.all([
      this.store.run(async tx => ({ outbox: (await tx.listOutbox(1e9)).length, inbox: (await tx.listInbox(0, 1e9)).length, cursor: Number((await tx.getMeta('cursor')) ?? 0) })),
      this.notes(),
    ])
    const est = await navigator.storage?.estimate?.().catch(() => undefined)
    return { ws: this.ws, device: this.device, leader: this.coord?.isLeader ?? false, ...p, persisted: this.persisted, usage: est?.usage ?? null, quota: est?.quota ?? null, offline: this.offline, rounds: this.coord?.rounds ?? 0, lastError: this.lastError, notes: notes.length }
  }

  projection(): Promise<Projection> { return projectStore(this.store) }
}
