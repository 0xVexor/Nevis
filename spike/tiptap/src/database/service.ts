// DatabaseService: the one object the UI talks to. It owns the coordinator, the in-memory state and the workflow engine, turns
// commits into a version number React can subscribe to (useSyncExternalStore), and answers queries with the caller's principal.
import type { CommandEnvelope, Commit, Id, Json, RecordKind } from './model/types.ts'
import { randomId } from './model/ids.ts'
import { toDbError } from './model/errors.ts'
import { Coordinator, type ChangeEvent } from './commands/index.ts'
import { Access } from './access.ts'
import { makeQuery, runQuery, type QueryRequest, type QueryResult } from './query/engine.ts'
import { Resolver } from './resolver.ts'
import { DbState, type PageStore } from './state.ts'
import type { DbStorage, PageHost } from './storage/types.ts'
import { MemoryLeases, type LeaseStore } from './workflows/lease.ts'
import { MemoryRuntime, WorkflowEngine, type RuntimeStore } from './workflows/engine.ts'
import type { ExternalAdapter } from './workflows/outbox.ts'
import { MemoryPages } from './state.ts'
import { selectGraph, type GraphQuery, type GraphResult, type PageSummary } from './graph.ts'

export const LOCAL_OWNER = 'local-owner'

export interface ServiceOptions {
  vaultId: Id
  storage: DbStorage
  pages: PageStore
  host: PageHost
  deviceId: Id
  principalId?: Id
  zone: string
  weekStart?: number
  runtime?: RuntimeStore
  leases?: LeaseStore
  adapters?: ExternalAdapter[]
  now?: () => number
}

export type ActionResult<T = Json> = { ok: true; commit: Commit; result: T } | { ok: false; code: string; message: string; detail: Record<string, unknown> }

export class DatabaseService {
  state: DbState
  coord: Coordinator
  storage: DbStorage
  engine: WorkflowEngine
  principalId: Id
  deviceId: Id
  vaultId: Id
  zone: string
  weekStart: number
  now: () => number
  quarantined: { kind: string; id: string; reason: string }[] = []
  /** read-only until recovery succeeded (RECOVERY_REQUIRED keeps the user out of a half-repaired vault) */
  recoveryError: string | null = null
  private version = 0
  private listeners = new Set<() => void>()
  private opened: Promise<void> | null = null

  constructor(o: ServiceOptions) {
    this.vaultId = o.vaultId
    this.deviceId = o.deviceId
    this.principalId = o.principalId ?? LOCAL_OWNER
    this.zone = o.zone
    this.weekStart = o.weekStart ?? 6
    this.now = o.now ?? Date.now
    this.storage = o.storage
    this.state = new DbState(o.vaultId, o.pages)
    this.coord = new Coordinator({ state: this.state, storage: o.storage, pageHost: o.host, deviceId: o.deviceId, now: this.now })
    this.engine = new WorkflowEngine({ coord: this.coord, runtime: o.runtime ?? new MemoryRuntime(), lease: o.leases ?? new MemoryLeases(), adapters: o.adapters, deviceId: o.deviceId, now: this.now, zone: o.zone })
    this.coord.subscribe((e) => this.bump(e))
  }

  /** Replays journals, loads every record, makes sure the local owner exists, starts the workflow engine. */
  open(): Promise<void> {
    return (this.opened ??= (async () => {
      try {
        this.quarantined = await this.coord.open()
      } catch (e) {
        this.recoveryError = toDbError(e).message
        this.bump()
        throw e
      }
      if (!this.state.get('principal', this.principalId)) await this.exec([{ type: 'principal.ensure_owner', payload: {} }], { operationId: `owner:${this.vaultId}` }).catch(() => undefined)
      this.engine.attach()
      this.bump()
    })())
  }

  // ───── React subscription ─────
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getVersion = () => this.version
  private bump(_e?: ChangeEvent) {
    this.version++
    this.listeners.forEach((f) => f())
  }

  // ───── commands ─────
  async exec(commands: { type: string; payload: Json }[], over: Partial<CommandEnvelope> = {}): Promise<Commit> {
    return this.coord.execute({ operationId: randomId(), vaultId: this.vaultId, actorId: this.principalId, deviceId: this.deviceId, expected: [], origin: 'user', commands, ...over })
  }
  /** Like exec, but never throws: UI code shows `message` and keeps its draft. */
  async tryExec(commands: { type: string; payload: Json }[], over: Partial<CommandEnvelope> = {}): Promise<ActionResult> {
    try {
      const commit = await this.exec(commands, over)
      return { ok: true, commit, result: (commit.result ?? null) as Json }
    } catch (e) {
      const d = toDbError(e)
      return { ok: false, code: d.code, message: d.message, detail: d.detail }
    }
  }
  async one<T = Record<string, Json>>(type: string, payload: unknown, over: Partial<CommandEnvelope> = {}): Promise<T> {
    return (await this.exec([{ type, payload: payload as Json }], over)).result as T
  }
  async undo(opts: { partial?: boolean } = {}) {
    return this.coord.undo(this.principalId, opts)
  }
  async reloadExternal(pageIds?: Id[]) {
    await this.coord.reloadExternal({ pages: pageIds })
  }

  // ───── reading ─────
  resolver(principalId = this.principalId): Resolver {
    return new Resolver(this.state, { principalId, nowMs: this.now(), zone: this.zone, weekStart: this.weekStart })
  }
  access() {
    return new Access(this.state)
  }
  nowIso() {
    return new Date(this.now()).toISOString()
  }
  query(sourceId: Id, over: Partial<QueryRequest> = {}): QueryResult {
    return runQuery(this.state, makeQuery(this.state, sourceId, this.principalId, this.nowIso(), this.zone, { weekStart: this.weekStart, ...over }), this.resolver())
  }
  graph(pages: PageSummary[], mentions: [Id, Id][], q: Omit<GraphQuery, 'vaultId' | 'principalId'>): GraphResult {
    return selectGraph(this.state, pages, mentions, { ...q, vaultId: this.vaultId, principalId: this.principalId })
  }
  /** containers hosted by this page (a database page, or inline databases embedded in it) */
  containersOf(hostPageId: Id) {
    return this.state.live('container').filter((c) => c.hostPageId === hostPageId)
  }
  isRow(pageId: Id) {
    return !!this.state.row(pageId)
  }
  kind<K extends RecordKind>(kind: K, id: Id) {
    return this.state.get(kind, id)
  }
}

/** For tests and storybook-like previews: a fully in-memory service. */
export async function memoryService(vaultId = 'preview', over: Partial<ServiceOptions> = {}) {
  const { MemoryStorage } = await import('./storage/memory.ts')
  const pages = new MemoryPages()
  const storage = new MemoryStorage(pages)
  const svc = new DatabaseService({
    vaultId, storage, pages,
    host: { get: pages.get, all: pages.all, adopt: (u, r) => { u.forEach((p) => pages.put(p)); r.forEach((id) => pages.delete(id)) } },
    deviceId: 'preview', zone: 'UTC', ...over,
  })
  await svc.open()
  return svc
}

