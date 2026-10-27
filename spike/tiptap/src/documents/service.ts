import { normalizeFa } from './normalize.ts'
import { cloneDocumentValue } from './clone.ts'
import { identifyBlocks, identityVersion, BLOCK_IDENTITY_VERSION } from './blockIdentity.ts'
import type { Page, PageKind, PageRepo, Patch } from './model.ts'
import { storedVersion } from './ports.ts'
import type { DocumentEnvironment, DocumentStorage, DocumentHost, StoredDocumentVersion } from './ports.ts'

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }
// a board is a page whose whole content is one drawing block (ids of its scene + picture files), so files, search, history and backup need nothing special
const EMPTY_BOARD = { type: 'doc', content: [{ type: 'drawing', attrs: { scene: '', preview: '' } }] }
// a to-do list is a page that starts as one empty checklist; its items are ordinary taskItems, so Tasks, search and sync need nothing special
const EMPTY_TODO = { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] }] }
const SNAPSHOT_EVERY = 10 * 60 * 1000 // at most one history entry per page per 10 minutes of editing

function textOf(node: any): string {
  if (!node) return ''
  if (node.text) return node.text
  return (node.content ?? []).map(textOf).join(' ')
}

const isBlankDoc = (doc: any) => !textOf(doc).trim() && (doc?.content ?? []).every((n: any) => n.type === 'paragraph')

/** ids of every page referenced by a pageLink node in a ProseMirror doc (derived, cf. page_links in ADR-0002). */
function linkedIds(node: any, out = new Set<string>()): Set<string> {
  if (!node || typeof node === 'string') return out
  if (node.type === 'pageLink' && node.attrs?.id) out.add(node.attrs.id)
  for (const c of node.content ?? []) linkedIds(c, out)
  return out
}

export class DocumentService implements PageRepo {
  private pages: Page[] = []
  private dirty = new Set<string>()
  private gone = new Set<string>()
  private full = false
  private cancelScheduled: (() => void) | null = null
  private queue: Promise<void> = Promise.resolve()
  private persistenceError: unknown = null
  private lastSnap = new Map<string, number>()
  /** Last loaded/durable compatibility version; not a strong document revision. */
  private diskAt = new Map<string, StoredDocumentVersion>()

  private seed: () => Page[]
  private readonly storage: DocumentStorage
  private readonly host: DocumentHost
  get vaultHandle() { return this.storage.vaultHandle }
  constructor(environment: DocumentEnvironment, seed: () => Page[] = () => []) {
    this.storage = environment.storage
    this.host = environment.host
    this.seed = seed
  }

  // ───── persistence ─────

  async init() {
    let rows: Page[] = []
    try {
      rows = await this.storage.load()
    } catch (e) {
      this.fail(e)
      throw e // an unavailable store is not an empty vault
    }
    if (!rows.length) {
      const legacy = this.host.readLegacy?.() ?? null
      this.pages = legacy ?? this.seed()
      this.migrateIdentities()
      this.rebuildLinks()
      this.full = true
      await this.writeNow()
      if (legacy) {
        // remove the old copy only once the new store demonstrably holds everything
        try {
          if ((await this.storage.load()).length === legacy.length) this.host.clearLegacy?.()
        } catch {
          /* keep the legacy copy */
        }
      }
    } else {
      this.pages = rows
      this.noteDisk(rows)
      this.migrateIdentities()
      this.rebuildLinks()
      await this.flushed()
    }
    this.host.requestPersistence?.()
  }

  private noteDisk(rows: Page[]) {
    this.diskAt = new Map(rows.map((r) => [r.id, storedVersion(r)]))
  }

  /** Re-run on imported/synced rows too. Identical legacy JSON converges to the
   * same document-local IDs on every device; persisted IDs are never positional. */
  private migrateIdentities() {
    for (const page of this.pages) {
      if (identityVersion(page.content) > BLOCK_IDENTITY_VERSION) continue
      const migration = identifyBlocks(page.content)
      if (!migration.changed) continue
      page.content = migration.content
      page.updatedAt = Math.max(this.host.now(), page.updatedAt + 1)
      if (page.recordMeta) page.recordMeta = { ...page.recordMeta, revision: (page.recordMeta.revision ?? 0) + 1 }
      this.touch(page.id)
    }
  }

  private fail(e: unknown) {
    this.host.report('storage', e)
    this.host.emit('storage-error', String(e))
  }

  private touch(...ids: string[]) {
    ids.forEach((i) => this.dirty.add(i))
    this.schedule()
  }

  private drop(ids: Iterable<string>) {
    for (const i of ids) (this.dirty.delete(i), this.gone.add(i))
    this.schedule()
  }

  private schedule() {
    if (this.cancelScheduled) return
    this.cancelScheduled = this.host.defer(() => {
      this.cancelScheduled = null
      void this.writeNow()
    })
  }

  /** Batches everything changed in the current tick into one IndexedDB transaction. */
  private writeNow(): Promise<void> {
    this.cancelScheduled?.()
    this.cancelScheduled = null
    const full = this.full
    const byId = new Map(this.pages.map((p) => [p.id, p]))
    const upserts = cloneDocumentValue(full ? this.pages : [...this.dirty].map((id) => byId.get(id)).filter((p): p is Page => !!p))
    const removed = full ? [] : [...this.gone]
    this.dirty.clear()
    this.gone.clear()
    this.full = false
    if (!full && !upserts.length && !removed.length) return this.queue
    this.queue = this.queue
      // desktop: tell the vault which version each edit started from, so that a newer version brought by the sync is kept in the history, not overwritten
      .then(() => this.storage.save({ upserts, removed, replaceAll: full,
        baseVersions: Object.fromEntries(upserts.map(p => [p.id, this.diskAt.get(p.id) ?? null])),
      }))
      .then(async () => {
        this.persistenceError = null
        for (const p of upserts) this.diskAt.set(p.id, storedVersion(p))
        if (this.storage.stamp) this.stamp = await this.storage.stamp() // our own writes are not "external" changes
      })
      .catch((e) => {
        this.persistenceError = e
        // Keep failed writes pending so they can be retried before installation.
        if (full) this.full = true
        for (const p of upserts) if (!this.gone.has(p.id)) this.dirty.add(p.id)
        for (const id of removed) if (!this.dirty.has(id)) this.gone.add(id)
        this.fail(e)
      })
    this.host.emit('data-changed')
    return this.queue
  }

  // ───── changes made by other devices (the vault folder is synced by a drive client) ─────

  private stamp = ''
  private polling = false

  private stopWatching: (() => void) | null = null
  private watching: Promise<void> | null = null
  private watchGeneration = 0
  /** Host owns timers, visibility and native subscriptions; core owns reload policy. */
  watch(): Promise<void> {
    if (!this.storage.stamp || !this.host.watchExternal) return Promise.resolve()
    if (this.watching) return this.watching
    const generation = ++this.watchGeneration
    return this.watching = (async () => {
      this.stamp = await this.storage.stamp!()
      if (generation !== this.watchGeneration) return
      const stop = await this.host.watchExternal!(() => { if (generation === this.watchGeneration) void this.poll() })
      if (generation !== this.watchGeneration) stop()
      else this.stopWatching = stop
    })().catch(error => { if (generation === this.watchGeneration) this.watching = null; throw error })
  }

  stopWatch() {
    this.watchGeneration++
    this.stopWatching?.()
    this.stopWatching = null
    this.watching = null
  }

  private idle = () => !this.dirty.size && !this.gone.size && !this.full

  private async poll() {
    if (this.polling || !this.idle()) return
    this.polling = true
    try {
      await this.queue
      if ((await this.storage.stamp!()) === this.stamp) return
      const rows = await this.storage.load() // also merges conflict copies, which changes the folder again
      if (!this.idle()) return // edited meanwhile: try again next round (the stamp is still different)
      const old = new Map(this.pages.map((p) => [p.id, p]))
      this.pages = rows
      this.noteDisk(rows)
      this.migrateIdentities()
      const changed = rows.filter((r) => old.get(r.id)?.updatedAt !== r.updatedAt || old.get(r.id)?.deletedAt !== r.deletedAt)
      const removed = old.size + changed.filter((c) => !old.has(c.id)).length - rows.length
      this.rebuildLinks()
      this.stamp = await this.storage.stamp!()
      if (changed.length || removed) this.host.emit('external-change', changed.map((c) => c.id))
    } catch (e) {
      this.host.report('watch', e)
    } finally {
      this.polling = false
    }
  }

  // ───── queries ─────

  list = () => this.pages.filter((p) => !p.deletedAt)
  pagesOnly = () => this.list().filter((p) => p.kind !== 'folder')
  get = (id: string) => this.pages.find((p) => p.id === id && !p.deletedAt)

  // ───── page links (derived from the content, cf. page_links in ADR-0002) ─────
  // out: page -> pages it links to; inn: page -> pages that link to it. Kept current per edited page, so
  // asking for backlinks never scans every document.

  private out = new Map<string, Set<string>>()
  private inn = new Map<string, Set<string>>()

  private unindexLinks(id: string) {
    for (const target of this.out.get(id) ?? []) this.inn.get(target)?.delete(id)
    this.out.delete(id)
  }

  private indexLinks(p: Page) {
    this.unindexLinks(p.id)
    if (p.kind === 'folder' || typeof p.content === 'string') return
    const targets = linkedIds(p.content)
    targets.delete(p.id)
    if (!targets.size) return
    this.out.set(p.id, targets)
    for (const t of targets) (this.inn.get(t) ?? this.inn.set(t, new Set()).get(t)!).add(p.id)
  }

  private rebuildLinks() {
    this.out.clear()
    this.inn.clear()
    this.pages.forEach((p) => this.indexLinks(p))
  }

  backlinks(id: string): Page[] {
    return [...(this.inn.get(id) ?? [])].map((s) => this.get(s)).filter((p): p is Page => !!p && p.kind !== 'folder')
  }

  linkGraph(): { nodes: Page[]; edges: [string, string][] } {
    const nodes = this.pagesOnly()
    const live = new Set(nodes.map((p) => p.id))
    const edges: [string, string][] = []
    for (const [from, targets] of this.out) if (live.has(from)) for (const to of targets) if (live.has(to)) edges.push([from, to])
    return { nodes, edges }
  }

  search(query: string): Page[] {
    const words = normalizeFa(query).split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return this.pagesOnly().filter((p) => {
      const hay = normalizeFa(`${p.title} ${(p.tags ?? []).join(' ')} ${textOf(p.content)}`)
      return words.every((w) => hay.includes(w))
    })
  }

  // ───── mutations ─────

  create(parentId: string | null, kind: PageKind = 'page'): Page {
    const sibs = this.pages.filter((p) => p.parentId === parentId)
    const page: Page = {
      id: this.host.createId(),
      parentId,
      ...(kind === 'folder' || kind === 'board' || kind === 'todo' ? { kind } : {}),
      title: '',
      favorite: false,
      sort: sibs.length ? Math.max(...sibs.map((s) => s.sort)) + 1 : 0,
      content: identifyBlocks(kind === 'board' ? EMPTY_BOARD : kind === 'todo' ? EMPTY_TODO : EMPTY_DOC).content,
      updatedAt: this.host.now(),
      deletedAt: null,
    }
    this.pages.push(page)
    this.touch(page.id)
    return page
  }

  update(id: string, patch: Patch, opts?: { history?: boolean; copyContent?: boolean }) {
    const p = this.pages.find((x) => x.id === id)
    if (!p) return
    if (patch.content !== undefined && identityVersion(p.content) > BLOCK_IDENTITY_VERSION) throw new Error('Unsupported block identity version')
    if (patch.content !== undefined) patch = { ...patch, content: identifyBlocks(patch.content, opts?.copyContent ? () => this.host.createId() : undefined).content }
    if (patch.content !== undefined && opts?.history !== false) this.snapshot(p)
    Object.assign(p, patch, { updatedAt: this.host.now() })
    if (p.database) p.recordMeta = { ...(p.recordMeta ?? { format: 1, revision: 0, createdAt: p.updatedAt, createdBy: '', updatedBy: '', lastOperationId: '', inferred: true }), revision: (p.recordMeta?.revision ?? 0) + 1 } // row edits through the editor are revisions too
    if (patch.content !== undefined) this.indexLinks(p)
    this.touch(id)
  }

  /** History: keep the state a page had *before* an edit burst, at most once per SNAPSHOT_EVERY. */
  private snapshot(p: Page) {
    const old = p.content
    if (p.kind === 'folder' || !old || typeof old === 'string' || isBlankDoc(old)) return
    const now = this.host.now()
    if (now - (this.lastSnap.get(p.id) ?? 0) < SNAPSHOT_EVERY) return
    this.lastSnap.set(p.id, now)
    const json = JSON.stringify(old)
    const copy = cloneDocumentValue(old)
    void this.storage.listVersions(p.id)
      .then((vs) => (vs[0] && JSON.stringify(vs[0].content) === json ? undefined : this.storage.addVersion({ pageId: p.id, ts: now, title: p.title, content: copy })))
      .catch((e) => this.host.report('history', e))
  }

  remove(id: string) {
    const now = this.host.now()
    const hit: string[] = []
    const walk = (pid: string) => {
      const p = this.pages.find((x) => x.id === pid)
      if (p && !p.deletedAt) p.deletedAt = now // keep the time of an earlier, separate delete
      hit.push(pid)
      this.pages.filter((c) => c.parentId === pid).forEach((c) => walk(c.id))
    }
    walk(id)
    this.touch(...hit)
  }

  move(id: string, parentId: string | null, beforeId: string | null): boolean {
    const page = this.pages.find((p) => p.id === id)
    if (!page || id === beforeId) return false
    // refuse to move a page into itself or one of its descendants
    for (let p = parentId ? this.pages.find((x) => x.id === parentId) : undefined; p; p = p.parentId ? this.pages.find((x) => x.id === p!.parentId) : undefined)
      if (p.id === id) return false
    const sibs = this.pages.filter((p) => p.parentId === parentId && p.id !== id && !p.deletedAt).sort((a, b) => a.sort - b.sort)
    const at = beforeId ? sibs.findIndex((s) => s.id === beforeId) : sibs.length
    sibs.splice(at < 0 ? sibs.length : at, 0, page)
    page.parentId = parentId
    sibs.forEach((s, i) => (s.sort = i))
    page.updatedAt = this.host.now()
    this.touch(page.id, ...sibs.map((s) => s.id))
    return true
  }

  trash(): Page[] {
    const byId = new Map(this.pages.map((p) => [p.id, p]))
    return this.pages
      .filter((p) => {
        if (!p.deletedAt) return false
        const par = p.parentId ? byId.get(p.parentId) : undefined
        // a page is a trash "root" unless its parent went to the trash in the same delete action
        return !par || !par.deletedAt || par.deletedAt !== p.deletedAt
      })
      .sort((a, b) => b.deletedAt! - a.deletedAt!)
  }

  restoreFromTrash(id: string) {
    const page = this.pages.find((p) => p.id === id)
    if (!page?.deletedAt) return
    const t = page.deletedAt
    const hit: string[] = []
    const walk = (pid: string) => {
      const p = this.pages.find((x) => x.id === pid)
      if (!p || p.deletedAt !== t) return
      p.deletedAt = null
      hit.push(pid)
      this.pages.filter((c) => c.parentId === pid).forEach((c) => walk(c.id))
    }
    walk(id)
    const parent = page.parentId ? this.pages.find((p) => p.id === page.parentId) : undefined
    if (page.parentId && (!parent || parent.deletedAt)) page.parentId = null // original parent is gone: restore at top level
    const sibs = this.pages.filter((p) => p.parentId === page.parentId && p.id !== id && !p.deletedAt)
    page.sort = sibs.length ? Math.max(...sibs.map((s) => s.sort)) + 1 : 0
    this.touch(...hit)
  }

  purge(id: string) {
    const gone = new Set<string>()
    const walk = (pid: string) => {
      gone.add(pid)
      this.pages.filter((c) => c.parentId === pid).forEach((c) => walk(c.id))
    }
    walk(id)
    this.pages = this.pages.filter((p) => !gone.has(p.id))
    gone.forEach((g) => this.unindexLinks(g))
    this.drop(gone)
    gone.forEach((g) => void this.storage.deleteVersions(g).catch(() => {}))
  }

  emptyTrash() {
    this.trash().forEach((p) => this.purge(p.id))
  }

  autoPurge(maxAgeMs: number): number {
    const old = this.trash().filter((p) => this.host.now() - p.deletedAt! > maxAgeMs)
    old.forEach((p) => this.purge(p.id))
    return old.length
  }

  dump = () => cloneDocumentValue(this.pages)

  restore(pages: Page[]) {
    this.pages = cloneDocumentValue(pages)
    this.migrateIdentities()
    this.rebuildLinks()
    this.full = true
    this.schedule()
  }

  /** Resolves when every pending change has reached IndexedDB (used by tests and before exports). */
  flushed(): Promise<void> {
    this.writeNow()
    return this.queue
  }

  async flushBeforeUpdate() {
    await this.flushed()
    if (this.persistenceError) throw this.persistenceError
  }

  // ───── database rows (src/database) ─────
  // A database row is an ordinary Page with a `database` extension. The database coordinator works on the same page objects.

  private rawIdx: Map<string, Page> | null = null
  private rawIdxFor: Page[] | null = null
  private rawIdxLen = -1
  private rawIndex() {
    if (!this.rawIdx || this.rawIdxFor !== this.pages || this.rawIdxLen !== this.pages.length) {
      this.rawIdx = new Map(this.pages.map((p) => [p.id, p]))
      this.rawIdxFor = this.pages
      this.rawIdxLen = this.pages.length
    }
    return this.rawIdx
  }

  /** Every page including the trash (a trashed row keeps its values and its links). */
  allRaw = (): Page[] => this.pages
  getRaw = (id: string): Page | undefined => this.rawIndex().get(id)

  /** Page bodies are always in memory here; kept so database views can ask for the bodies they are about to show. */
  async ensureContent(_ids: string | string[]): Promise<void> {}

  /** Resolves when pending page writes reached the store, so the database coordinator compares revisions against what is stored. */
  async flushForDatabase() {
    await this.flushed()
  }

  /** The database coordinator already made these post-images durable: take them over in memory without writing them again. */
  adoptDatabase(upserts: Page[], removed: string[]) {
    const idx = this.rawIndex()
    for (const u of upserts) {
      const cur = idx.get(u.id)
      if (cur) {
        const body = cur.content
        for (const k of Object.keys(cur)) if (!(k in u)) delete (cur as unknown as Record<string, unknown>)[k] // e.g. the extension was removed
        Object.assign(cur, u)
        if (u.content === undefined) cur.content = body // a bodyless post-image keeps the body that is in memory
        this.indexLinks(cur)
        this.dirty.delete(u.id)
        this.diskAt.set(u.id, storedVersion(u))
      } else {
        this.pages.push(u)
        idx.set(u.id, u)
        this.rawIdxLen = this.pages.length
        this.dirty.delete(u.id)
        this.diskAt.set(u.id, storedVersion(u))
        if (u.content !== undefined) this.indexLinks(u)
      }
    }
    if (removed.length) {
      const gone = new Set(removed)
      this.pages = this.pages.filter((p) => !gone.has(p.id))
      gone.forEach((g) => (this.unindexLinks(g), this.dirty.delete(g)))
    }
    this.host.emit('data-changed')
  }

  /** Another tab / device changed the stored pages: read them again, unless there are unsaved edits here (then the next poll retries). */
  async refreshFromStore(): Promise<boolean> {
    if (!this.idle()) return false
    await this.queue
    const rows = await this.storage.load()
    if (!this.idle()) return false
    const old = new Map(this.pages.map((p) => [p.id, p]))
    this.pages = rows
    this.noteDisk(rows)
    this.migrateIdentities()
    const changed = rows.filter((r) => old.get(r.id)?.updatedAt !== r.updatedAt || old.get(r.id)?.deletedAt !== r.deletedAt || (r.recordMeta?.revision ?? 0) !== ((old.get(r.id) as Page | undefined)?.recordMeta?.revision ?? 0))
    this.rebuildLinks()
    this.host.emit('external-change', changed.map((c) => c.id))
    return true
  }
}
