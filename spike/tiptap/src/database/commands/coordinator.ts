// The single mutation coordinator (handoff §6, §12). Every write — database commands and, through an adapter, the legacy page
// repo — goes through here: serialize, check idempotency and expected revisions, run handlers on a Draft, validate the whole
// batch, hand one atomic BatchWrite to storage, and only then publish the new state and notify subscribers.
import type { Cell, Commit, CommandEnvelope, Id, Json, PageLike, RecordKind, RecordMeta } from '../model/types.ts'
import { DbError, fail, toDbError } from '../model/errors.ts'
import { randomId, type IdGen } from '../model/ids.ts'
import { same, stable } from '../model/json.ts'
import { Access } from '../access.ts'
import { DbState, type AnyRecord, type Records } from '../state.ts'
import type { BatchWrite, DbStorage, HistoryWrite, PageHost, PageWrite, RecordWrite, UndoGroup, UndoItem, UndoPath } from '../storage/types.ts'
import { Draft } from './draft.ts'

export type PageChange = {
  pageId: Id
  sourceId: Id | null
  created: boolean
  trashed: boolean
  restored: boolean
  titleChanged: boolean
  cells: Record<Id, { before: Cell | null; after: Cell | null }>
  membershipChanged: boolean
}

export type ChangeEvent = {
  commit: Commit
  envelope: CommandEnvelope
  pages: PageChange[]
  records: { kind: RecordKind; id: Id; deleted: boolean }[]
  /** set for changes that arrived from outside this process (another tab, another program) */
  external?: boolean
}

export interface Ctx {
  d: Draft
  env: CommandEnvelope
  now: number
  ids: IdGen
  access: Access
  state: DbState
  warnings: { code: string; detail: string }[]
  /** metadata for a brand-new record */
  meta(id?: Id): RecordMeta
  stamp(): { counter: number; deviceId: Id; opId: Id }
  /** result of the previous command in this batch, so a later command can use a freshly created id */
  last: Json
}
export type Handler = (cx: Ctx, payload: any) => Json | void

export const HANDLERS: Record<string, Handler> = {}
export const register = (type: string, h: Handler) => void (HANDLERS[type] = h)

export const PAGE_SKIP = new Set(['recordMeta', 'updatedAt'])

export interface CoordinatorOptions {
  state: DbState
  storage: DbStorage
  pageHost: PageHost
  deviceId: Id
  now?: () => number
  ids?: IdGen
  undoLimit?: number
}

export class Coordinator {
  state: DbState
  storage: DbStorage
  host: PageHost
  deviceId: Id
  now: () => number
  ids: IdGen
  undoLimit: number
  undoStack: UndoGroup[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private subs = new Set<(e: ChangeEvent) => void>()
  private opCache = new Map<Id, Commit>()
  locked = false // set when recovery failed: read-only until the user repairs

  constructor(o: CoordinatorOptions) {
    this.state = o.state
    this.storage = o.storage
    this.host = o.pageHost
    this.deviceId = o.deviceId
    this.now = o.now ?? Date.now
    this.ids = o.ids ?? randomId
    this.undoLimit = o.undoLimit ?? 200
  }

  subscribe(fn: (e: ChangeEvent) => void) {
    this.subs.add(fn)
    return () => void this.subs.delete(fn)
  }

  /** Startup: replay journals, then load every record. Writable UI must wait for this. */
  async open() {
    try {
      await this.storage.recover()
    } catch (e) {
      this.locked = true
      throw e
    }
    const loaded = await this.storage.loadAll()
    this.state.maps = (await import('../state.ts')).emptyMaps()
    for (const [kind, list] of Object.entries(loaded.records)) for (const r of list ?? []) (this.state.maps as Record<string, Map<Id, unknown>>)[kind].set(r.id, r)
    this.state.invalidate()
    this.undoStack = await this.storage.loadUndo()
    return loaded.quarantined
  }

  execute(env: CommandEnvelope): Promise<Commit> {
    const run = this.chain.then(() => this.run(env))
    this.chain = run.catch(() => undefined)
    return run
  }

  async flushed(): Promise<void> { await this.chain }

  private async run(env: CommandEnvelope): Promise<Commit> {
    if (this.locked) fail('RECOVERY_REQUIRED', 'the database needs repair before it can be written')
    if (env.vaultId !== this.state.vaultId) fail('SCHEMA_MISMATCH', 'command belongs to another vault')
    await this.host.flush?.()
    const done = this.opCache.get(env.operationId) ?? (await this.storage.getOperation(env.operationId))
    if (done) return done // retry of an applied operation: same answer, nothing duplicated

    const access = new Access(this.state)
    if (!access.principal(env.actorId) && !env.commands.every((c) => c.type === 'database.create' || c.type === 'principal.ensure_owner'))
      fail('ACCESS_DENIED', 'unknown actor', { actorId: env.actorId })

    const stale = this.staleExpectations(env)
    const d = new Draft(this.state)
    const now = this.now()
    const ids = this.ids
    const cx: Ctx = {
      d, env, now, ids, access, state: this.state, warnings: [], last: null,
      meta: (id) => ({ format: 1, id: id ?? ids(), vaultId: env.vaultId, revision: 0, createdAt: now, updatedAt: now, createdBy: env.actorId, updatedBy: env.actorId, deletedAt: null, lastOperationId: env.operationId }),
      stamp: () => ({ counter: 0, deviceId: env.deviceId, opId: env.operationId }),
    }
    if (stale.length) this.checkRebase(env, stale)

    const results: Json[] = []
    for (const c of env.commands) {
      const h = HANDLERS[c.type]
      if (!h) fail('INVALID_COMMAND', `unknown command ${c.type}`)
      const r = h(cx, c.payload) ?? null
      cx.last = r
      results.push(r)
    }

    const fin = this.finalize(cx, results)
    if (!fin.batch.records.length && !fin.batch.pages.length) {
      // nothing changed: succeed without a revision (no-op edits do not touch updatedAt)
      this.opCache.set(env.operationId, fin.batch.commit)
      return fin.batch.commit
    }
    try {
      await this.storage.commit(fin.batch)
    } catch (e) {
      throw toDbError(e) // nothing was published; the caller keeps its draft and can retry with the same operation id
    }
    this.publish(fin.batch, fin.events)
    this.opCache.set(env.operationId, fin.batch.commit)
    if (fin.batch.undo) {
      this.undoStack.push(fin.batch.undo)
      if (this.undoStack.length > this.undoLimit) this.undoStack.splice(0, this.undoStack.length - this.undoLimit)
      void this.storage.saveUndo(this.undoStack).catch(() => undefined)
    }
    const ev: ChangeEvent = { commit: fin.batch.commit, envelope: env, pages: fin.pageChanges, records: fin.events }
    for (const s of this.subs) s(ev)
    return fin.batch.commit
  }

  // ───── expected revisions ─────

  private revisionOf(kind: string, id: Id): number | null {
    if (kind === 'page') {
      const p = this.state.pages.get(id)
      return p ? (p.recordMeta?.revision ?? 0) : null
    }
    return this.state.get(kind as RecordKind, id)?.revision ?? null
  }

  private staleExpectations(env: CommandEnvelope) {
    const out: { kind: string; id: Id; expected: number; actual: number | null }[] = []
    for (const e of env.expected) {
      const actual = this.revisionOf(e.recordKind, e.id)
      if (actual !== e.revision) out.push({ kind: e.recordKind, id: e.id, expected: e.revision, actual })
    }
    return out
  }

  /** A stale page expectation is rebased only for explicit `row.patch` cell changes whose cells did not change since. */
  private checkRebase(env: CommandEnvelope, stale: { kind: string; id: Id; expected: number; actual: number | null }[]) {
    for (const s of stale) {
      let ok = s.kind === 'page' && s.actual !== null
      if (ok) {
        const page = this.state.pages.get(s.id)!
        for (const c of env.commands) {
          const p = c.payload as { pageId?: Id; cellChanges?: Record<Id, unknown>; title?: string; parentItemId?: unknown } | null
          if (c.type !== 'row.patch' || p?.pageId !== s.id || p.title !== undefined || p.parentItemId !== undefined) { ok = false; break }
          for (const pid of Object.keys(p.cellChanges ?? {})) if ((page.database?.cells[pid]?.stamp.counter ?? 0) > s.expected) ok = false
        }
        if (!ok || !env.commands.some((c) => (c.payload as { pageId?: Id } | null)?.pageId === s.id)) ok = false
      }
      if (!ok) fail('REVISION_CONFLICT', `${s.kind}/${s.id} changed (expected revision ${s.expected}, now ${s.actual})`, { recordKind: s.kind, id: s.id, expected: s.expected, current: s.actual })
    }
  }

  // ───── finalize: revisions, history, undo, batch ─────

  private finalize(cx: Ctx, results: Json[]) {
    const { d, env, now } = cx
    const records: RecordWrite[] = []
    const pages: PageWrite[] = []
    const history: HistoryWrite[] = []
    const undoItems: UndoItem[] = []
    const events: ChangeEvent['records'] = []
    const pageChanges: PageChange[] = []
    const changed: Commit['changed'] = []

    for (const [key, rec] of d.recs) {
      const [kind, ...rest] = key.split(':')
      const id = rest.join(':')
      const base = this.state.get(kind as RecordKind, id) as AnyRecord | undefined
      if (rec === null) {
        if (!base) continue
        records.push({ kind: kind as RecordKind, id, baseRevision: base.revision, after: null })
        history.push({ recordKind: kind, id, revision: base.revision, body: base as unknown as Json })
        events.push({ kind: kind as RecordKind, id, deleted: true })
        continue
      }
      if (base && same(strip(base), strip(rec))) continue
      const post = rec as AnyRecord
      post.revision = (base?.revision ?? 0) + 1
      post.updatedAt = now
      post.updatedBy = env.actorId
      post.lastOperationId = env.operationId
      if (!base) {
        post.createdAt = now
        post.createdBy = env.actorId
      }
      records.push({ kind: kind as RecordKind, id, baseRevision: base?.revision ?? 0, after: post })
      if (base) history.push({ recordKind: kind, id, revision: base.revision, body: base as unknown as Json })
      undoItems.push({ t: 'record', kind: kind as RecordKind, id, afterRevision: post.revision, before: base ? structuredClone(base) : null })
      events.push({ kind: kind as RecordKind, id, deleted: false })
      changed.push({ recordKind: kind, id, revision: post.revision })
    }

    for (const [id, p] of d.pgs) {
      const base = this.state.pages.get(id)
      if (p === null) {
        if (!base) continue
        pages.push({ id, baseRevision: base.recordMeta?.revision ?? 0, after: null })
        continue
      }
      if (base && same(stripPage(base), stripPage(p))) continue
      const baseRev = base?.recordMeta?.revision ?? 0
      const rev = baseRev + 1
      const meta = p.recordMeta ?? { format: 1 as const, revision: 0, createdAt: base?.updatedAt ?? now, createdBy: env.actorId, updatedBy: env.actorId, lastOperationId: env.operationId, inferred: !!base }
      p.recordMeta = { ...meta, format: 1, revision: rev, updatedBy: env.actorId, lastOperationId: env.operationId }
      p.updatedAt = now
      if (p.database) {
        const bext = base?.database
        const extChanged = !bext || !same({ ...bext, revision: 0 }, { ...p.database, revision: 0 })
        if (extChanged) p.database.revision = (bext?.revision ?? 0) + 1
        for (const c of Object.values(p.database.cells)) if (c.stamp.opId === env.operationId) c.stamp.counter = rev
      }
      pages.push({ id, baseRevision: baseRev, after: p })
      changed.push({ recordKind: 'page', id, revision: rev })
      if (base) {
        const snap: PageLike = { ...base }
        if (base.content === p.content) delete snap.content // body unchanged: the page history already keeps bodies
        history.push({ recordKind: 'page', id, revision: baseRev, body: snap as unknown as Json })
      }
      const ch = diffPage(base, p)
      pageChanges.push(ch.change)
      undoItems.push({ t: 'page', id, afterRevision: rev, paths: ch.paths, created: !base })
    }

    const commit: Commit = { operationId: env.operationId, generation: this.state.generation + 1, changed, warnings: cx.warnings, result: results.length === 1 ? results[0] : results }
    const label = env.commands.map((c) => c.type).join(', ')
    const isUndo = env.commands.some((c) => c.type === 'undo.apply')
    const undo: UndoGroup | null = undoItems.length && !isUndo ? { operationId: env.operationId, label, ts: now, actorId: env.actorId, items: undoItems } : null
    return { batch: { operationId: env.operationId, vaultId: env.vaultId, records, pages, history, commit, undo } as BatchWrite, events, pageChanges }
  }

  /** Adopt the durable post-images. Runs only after storage.commit resolved. */
  private publish(batch: BatchWrite, _events: ChangeEvent['records']) {
    const ups: PageLike[] = []
    const rem: Id[] = []
    for (const w of batch.pages) (w.after ? ups.push(w.after) : rem.push(w.id))
    for (const w of batch.records) {
      if (w.after) (this.state.maps[w.kind] as Map<Id, AnyRecord>).set(w.id, w.after)
      else this.state.maps[w.kind].delete(w.id)
    }
    this.host.adopt(ups, rem)
    this.state.invalidate()
    batch.commit.generation = this.state.generation
  }

  /** Apply changes that another process wrote (another tab, another program): refresh records and pages, then notify. */
  async reloadExternal(ids?: { pages?: Id[] }) {
    const loaded = await this.storage.loadAll()
    this.state.maps = (await import('../state.ts')).emptyMaps()
    for (const [kind, list] of Object.entries(loaded.records)) for (const r of list ?? []) (this.state.maps as Record<string, Map<Id, unknown>>)[kind].set(r.id, r)
    this.state.invalidate()
    const ev: ChangeEvent = { commit: { operationId: 'external', generation: this.state.generation, changed: [], warnings: [] }, envelope: { operationId: 'external', vaultId: this.state.vaultId, actorId: '', deviceId: '', expected: [], origin: 'sync', commands: [] }, pages: (ids?.pages ?? []).map((pageId) => ({ pageId, sourceId: null, created: false, trashed: false, restored: false, titleChanged: false, cells: {}, membershipChanged: false })), records: [], external: true }
    for (const s of this.subs) s(ev)
  }

  // ───── undo ─────

  /** Preview what undoing the latest group would do. */
  undoPreview(): { group: UndoGroup | null; conflicts: { id: Id; path: string }[] } {
    const group = this.undoStack[this.undoStack.length - 1] ?? null
    if (!group) return { group: null, conflicts: [] }
    return { group, conflicts: this.undoConflicts(group) }
  }

  private undoConflicts(g: UndoGroup) {
    const out: { id: Id; path: string }[] = []
    for (const it of g.items) {
      if (it.t === 'record') {
        const cur = this.state.get(it.kind, it.id)
        if (!cur || cur.revision !== it.afterRevision) out.push({ id: it.id, path: it.kind })
      } else {
        const p = this.state.pages.get(it.id)
        if (!p) { out.push({ id: it.id, path: 'page' }); continue }
        for (const path of it.paths) if (!same(readPath(p, path.path), path.after)) out.push({ id: it.id, path: path.path })
      }
    }
    return out
  }

  /** Undo the latest group. With conflicts it refuses unless `partial` is set, which restores only the untouched fields. */
  async undo(actorId: Id, opts: { partial?: boolean } = {}): Promise<{ ok: boolean; conflicts: { id: Id; path: string }[]; commit?: Commit }> {
    const group = this.undoStack[this.undoStack.length - 1]
    if (!group) return { ok: false, conflicts: [] }
    const conflicts = this.undoConflicts(group)
    if (conflicts.length && !opts.partial) return { ok: false, conflicts }
    const commit = await this.execute({
      operationId: this.ids(), vaultId: this.state.vaultId, actorId, deviceId: this.deviceId, expected: [], origin: 'user',
      commands: [{ type: 'undo.apply', payload: { group: group as unknown as Json, skip: conflicts as unknown as Json } }],
    })
    this.undoStack = this.undoStack.filter((g) => g !== group && g.operationId !== group.operationId)
    // the undo itself is not pushed again as an undoable group of the group it reverted (redo is a fresh edit)
    void this.storage.saveUndo(this.undoStack).catch(() => undefined)
    return { ok: true, conflicts, commit }
  }
}

// ───── diff helpers ─────

const META_KEYS = ['revision', 'updatedAt', 'updatedBy', 'lastOperationId']
function strip(r: unknown): unknown {
  const o = { ...(r as Record<string, unknown>) }
  for (const k of META_KEYS) delete o[k]
  return o
}
function stripPage(p: PageLike): unknown {
  const o = { ...p } as Record<string, unknown>
  for (const k of PAGE_SKIP) delete o[k]
  if (p.database) o.database = { ...p.database, revision: 0, cells: Object.fromEntries(Object.entries(p.database.cells).map(([k, c]) => [k, { value: c.value }])) }
  return o
}

export function readPath(p: PageLike, path: string): Json | null {
  if (path === 'title') return p.title
  if (path === 'icon') return (p.icon ?? null) as Json
  if (path === 'deletedAt') return p.deletedAt
  if (path === 'parentId') return p.parentId
  if (path === 'ext') return (p.database ?? null) as unknown as Json
  const e = p.database
  if (!e) return null
  if (path === 'ext.sortKey') return e.sortKey
  if (path === 'ext.parentItemId') return e.parentItemId
  if (path === 'ext.sourceId') return e.sourceId
  if (path.startsWith('cell:')) return (e.cells[path.slice(5)]?.value ?? null) as unknown as Json
  if (path.startsWith('alloc:')) return e.allocatedIds[path.slice(6)] ?? null
  return null
}

export function writePath(p: PageLike, path: string, v: Json | null, stamp?: { counter: number; deviceId: Id; opId: Id }) {
  if (path === 'title') p.title = v as string
  else if (path === 'icon') (v === null ? delete p.icon : (p.icon = v as string))
  else if (path === 'deletedAt') p.deletedAt = v as number | null
  else if (path === 'parentId') p.parentId = v as Id | null
  else if (path === 'ext') (v === null ? delete p.database : (p.database = structuredClone(v) as never))
  else if (p.database) {
    const e = p.database
    if (path === 'ext.sortKey') e.sortKey = v as string
    else if (path === 'ext.parentItemId') e.parentItemId = v as Id | null
    else if (path === 'ext.sourceId') e.sourceId = v as Id
    else if (path.startsWith('cell:')) {
      const id = path.slice(5)
      if (v === null) delete e.cells[id]
      else e.cells[id] = { value: structuredClone(v) as Cell, stamp: stamp ?? { counter: 0, deviceId: '', opId: '' } }
    } else if (path.startsWith('alloc:')) {
      const id = path.slice(6)
      if (v === null) delete e.allocatedIds[id]
      else e.allocatedIds[id] = v as string
    }
  }
}

function diffPage(base: PageLike | undefined, post: PageLike): { change: PageChange; paths: UndoPath[] } {
  const paths: UndoPath[] = []
  const change: PageChange = {
    pageId: post.id, sourceId: post.database?.sourceId ?? base?.database?.sourceId ?? null, created: !base, trashed: false, restored: false, titleChanged: false, cells: {}, membershipChanged: false,
  }
  const add = (path: string, before: Json | null, after: Json | null) => {
    if (!same(before, after)) paths.push({ path, before, after })
  }
  const b = (path: string) => (base ? readPath(base, path) : null)
  add('title', b('title'), post.title)
  add('icon', b('icon'), (post.icon ?? null) as Json)
  add('deletedAt', b('deletedAt'), post.deletedAt)
  add('parentId', b('parentId'), post.parentId)
  change.titleChanged = !base || base.title !== post.title
  change.trashed = !!post.deletedAt && !base?.deletedAt
  change.restored = !post.deletedAt && !!base?.deletedAt
  const be = base?.database
  const pe = post.database
  if (!be !== !pe || (be && pe && be.sourceId !== pe.sourceId)) {
    change.membershipChanged = true
    add('ext', (be ?? null) as unknown as Json, (pe ?? null) as unknown as Json)
  } else if (be && pe) {
    add('ext.sortKey', be.sortKey, pe.sortKey)
    add('ext.parentItemId', be.parentItemId, pe.parentItemId)
    for (const id of new Set([...Object.keys(be.cells), ...Object.keys(pe.cells)])) {
      const bv = be.cells[id]?.value ?? null
      const pv = pe.cells[id]?.value ?? null
      if (!same(bv, pv)) {
        paths.push({ path: `cell:${id}`, before: bv as unknown as Json, after: pv as unknown as Json })
        change.cells[id] = { before: bv, after: pv }
      }
    }
    for (const id of new Set([...Object.keys(be.allocatedIds), ...Object.keys(pe.allocatedIds)])) add(`alloc:${id}`, be.allocatedIds[id] ?? null, pe.allocatedIds[id] ?? null)
  }
  if (pe && !be) for (const [id, c] of Object.entries(pe.cells)) change.cells[id] = { before: null, after: c.value }
  return { change, paths }
}

export { stable, DbError }
export type { Records }
