import { canonicalDocumentValue, documentRevision } from './revision.ts'
import { cloneDocumentValue } from './clone.ts'
import { identifyBlocks, identityVersion, BLOCK_IDENTITY_VERSION } from './blockIdentity.ts'
import type { Page, PageKind, PageRepo, Patch } from './model.ts'
import { storedVersion } from './ports.ts'
import { DocumentReader } from './reader.ts'
import type { DocumentReadGrant, DocumentReadRuntime } from './reader.ts'
import type { DocumentEnvironment, DocumentStorage, DocumentHost, StoredDocumentVersion } from './ports.ts'
import { canonicalSnapshot, ManagedLexicalIndex, rankedSearchPages, SearchIndexUnavailable } from './searchLifecycle.ts'
import { LexicalSearchError, PortableLexicalIndex } from './lexicalSearch.ts'
import type { SearchIndexRuntime } from './searchLifecycle.ts'

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
  private diskPages = new Map<string, Page>()

  private drafts = new Set<string>()
  private commitLocked = false
  private editGeneration = 0
  isWriteLocked = () => this.commitLocked
  setEditorDirty(id: string, dirty: boolean) {
    if (dirty) { this.assertWritable(); this.drafts.add(id); this.editGeneration++ }
    else this.drafts.delete(id)
  }
  private assertWritable() {
    if (this.commitLocked) throw new Error('Document commit in progress')
  }
  /** Reserve only the local persistence interval. Planners and network calls run before this. */
  async reserveCommit(): Promise<() => void> {
    this.assertWritable()
    const generation = this.editGeneration
    if (this.drafts.size) throw new Error('Document editor has unsaved changes')
    await this.flushBeforeUpdate()
    this.assertWritable()
    if (this.drafts.size || generation !== this.editGeneration || !this.idle()) throw new Error('Document editor changed')
    this.commitLocked = true
    this.host.emit('commit-state')
    return () => { this.commitLocked = false; this.host.emit('commit-state') }
  }
  /** Internal commit boundary for the later validated edit planner. No transport or access grant is exposed here. */
  async commitDocument(expected: Page, next: Page, expectedRevision: string, digest: (value: string) => Promise<string>) {
    const before = cloneDocumentValue(expected), after = cloneDocumentValue(next)
    if (before.id !== after.id) throw new Error('Document identity changed')
    if (await documentRevision(before, digest) !== expectedRevision) throw new Error('Document revision conflict')
    const revision = await documentRevision(after, digest)
    const release = await this.reserveCommit()
    try {
      if (canonicalDocumentValue(this.getRaw(before.id)) !== canonicalDocumentValue(before)) throw new Error('Document revision conflict')
      await this.storage.save({ upserts: [after], removed: [], replaceAll: false, baseVersions: { [before.id]: storedVersion(before) }, expectedPages: { [before.id]: before } })
      this.adoptDatabase([after], [])
      this.host.emit('external-change', [after.id])
      return { documentId: after.id, revision }
    } finally { release() }
  }

  private seed: () => Page[]
  private readonly storage: DocumentStorage
  private readonly host: DocumentHost
  private readonly searchIndex: ManagedLexicalIndex
  private readonly searchRuntime: SearchIndexRuntime
  private searchGeneration = 0
  private invalidateSearch() { this.searchGeneration++; this.searchIndex.invalidate() }
  get vaultHandle() { return this.storage.vaultHandle }
  /** Read persisted state after already-queued writes; never flush a dirty editor. */
  reader(grant: DocumentReadGrant, runtime: DocumentReadRuntime) {
    return new DocumentReader({ vaultHandle: this.vaultHandle, searchRuntime: this.searchRuntime, load: async () => { await this.queue; return this.storage.load() } }, grant, runtime)
  }
  constructor(environment: DocumentEnvironment, seed: () => Page[] = () => []) {
    this.storage = environment.storage
    this.host = environment.host
    this.searchRuntime = environment.search ?? {}
    this.searchIndex = new ManagedLexicalIndex(this.searchRuntime, state => this.host.emit('search-state', state))
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
      if (this.persistenceError) throw this.persistenceError
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
    this.invalidateSearch()
  }

  private noteDisk(rows: Page[]) {
    this.diskAt = new Map(rows.map((r) => [r.id, storedVersion(r)]))
    this.diskPages = new Map(rows.map(r => [r.id, cloneDocumentValue(r)]))
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
    this.editGeneration++
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
      // Compare detached durable pre-images, including same-timestamp metadata changes.
      .then(() => this.storage.save({ upserts, removed, replaceAll: full,
        baseVersions: Object.fromEntries(upserts.map(p => [p.id, this.diskAt.get(p.id) ?? null])),
        ...(full ? { expectedAll: [...this.diskPages.values()].map(cloneDocumentValue) }
          : { expectedPages: Object.fromEntries([...upserts.map(p => p.id), ...removed].map(id => [id, cloneDocumentValue(this.diskPages.get(id) ?? null)])) }),
      }))
      .then(async () => {
        if (this.idle()) this.persistenceError = null
        if (full) { this.diskAt.clear(); this.diskPages.clear() }
        for (const p of upserts) { this.diskAt.set(p.id, storedVersion(p)); this.diskPages.set(p.id, cloneDocumentValue(p)) }
        for (const id of removed) { this.diskAt.delete(id); this.diskPages.delete(id) }
        this.invalidateSearch() // committed content first; indexing is a separate, fallible concern
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
    if (!this.host.watchExternal) return Promise.resolve()
    if (this.watching) return this.watching
    const generation = ++this.watchGeneration
    return this.watching = (async () => {
      this.stamp = this.storage.stamp ? await this.storage.stamp() : ''
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
  private canReload = () => this.idle() && !this.drafts.size && !this.commitLocked

  private async poll() {
    if (this.polling || !this.canReload()) return
    this.polling = true
    try {
      await this.queue
      if (this.storage.stamp && (await this.storage.stamp()) === this.stamp) return
      const rows = await this.storage.load() // also merges conflict copies, which changes the folder again
      if (!this.canReload()) return // edited meanwhile: try again next round (the stamp is still different)
      const old = new Map(this.pages.map((p) => [p.id, p]))
      this.pages = rows
      this.noteDisk(rows)
      this.migrateIdentities()
      const changed = rows.filter(r => canonicalSnapshot(old.get(r.id)) !== canonicalSnapshot(r))
      const removed = old.size + changed.filter((c) => !old.has(c.id)).length - rows.length
      this.rebuildLinks()
      this.stamp = this.storage.stamp ? await this.storage.stamp() : ''
      if (changed.length || removed) {
        this.invalidateSearch()
        this.host.emit('external-change', [...changed.map(c => c.id), ...[...old.keys()].filter(id => !rows.some(row => row.id === id))])
      }
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
    if (!query.trim()) return []
    try { return rankedSearchPages(new PortableLexicalIndex(this.pagesOnly()), this.pagesOnly(), query) }
    catch (error) { if (error instanceof LexicalSearchError && error.code === 'INVALID_ARGUMENT') return []; throw error }
  }

  searchStatus() { return this.searchIndex.status() }
  async refreshSearchIndex() {
    try {
      await this.queue
      const generation = this.searchGeneration
      const pages = (await this.storage.load()).filter(page => page.deletedAt === null && page.kind !== 'folder')
      if (generation !== this.searchGeneration) return { state: 'pending' as const, index: null, pages: [] as Page[], generation }
      const snapshot = canonicalSnapshot([...pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { ...await this.searchIndex.prepare(pages, snapshot), pages, generation }
    } catch { return { ...this.searchIndex.failed(), pages: [] as Page[], generation: this.searchGeneration } }
  }
  async searchPersisted(query: string): Promise<(Page & { searchPassage: string })[]> {
    if (!query.trim()) return []
    const prepared = await this.refreshSearchIndex()
    if (prepared.generation !== this.searchGeneration || (prepared.index && !this.searchIndex.isCurrent(prepared.index))) throw new SearchIndexUnavailable(this.searchIndex.status() === 'failed' ? 'failed' : 'pending')
    if (prepared.state !== 'fresh' || !prepared.index) throw new SearchIndexUnavailable(prepared.state === 'pending' ? 'pending' : 'failed')
    try { return rankedSearchPages(prepared.index, prepared.pages, query) }
    catch (error) { if (error instanceof LexicalSearchError && error.code === 'INVALID_ARGUMENT') return []; throw error }
  }

  // ───── mutations ─────

  create(parentId: string | null, kind: PageKind = 'page'): Page {
    this.assertWritable()
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
    this.assertWritable()
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
    this.assertWritable()
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
    this.assertWritable()
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
    this.assertWritable()
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
    this.assertWritable()
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
    this.assertWritable()
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
    await this.flushBeforeUpdate()
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
        this.diskPages.set(u.id, cloneDocumentValue(cur))
      } else {
        this.pages.push(u)
        idx.set(u.id, u)
        this.rawIdxLen = this.pages.length
        this.dirty.delete(u.id)
        this.diskAt.set(u.id, storedVersion(u))
        this.diskPages.set(u.id, cloneDocumentValue(u))
        if (u.content !== undefined) this.indexLinks(u)
      }
    }
    if (removed.length) {
      const gone = new Set(removed)
      this.pages = this.pages.filter((p) => !gone.has(p.id))
      gone.forEach((g) => (this.unindexLinks(g), this.dirty.delete(g), this.diskAt.delete(g), this.diskPages.delete(g)))
    }
    this.invalidateSearch()
    this.host.emit('data-changed')
  }

  /** Another tab / device changed the stored pages: read them again, unless there are unsaved edits here (then the next poll retries). */
  async refreshFromStore(): Promise<boolean> {
    if (!this.canReload()) return false
    await this.queue
    const rows = await this.storage.load()
    if (!this.canReload()) return false
    const old = new Map(this.pages.map((p) => [p.id, p]))
    this.pages = rows
    this.noteDisk(rows)
    this.migrateIdentities()
    const changed = rows.filter(r => canonicalSnapshot(old.get(r.id)) !== canonicalSnapshot(r))
    this.rebuildLinks()
    if (changed.length || [...old.keys()].some(id => !rows.some(row => row.id === id))) this.invalidateSearch()
    this.host.emit('external-change', [...changed.map(c => c.id), ...[...old.keys()].filter(id => !rows.some(row => row.id === id))])
    return true
  }
}
