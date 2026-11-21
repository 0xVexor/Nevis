// The notes app's state for one workspace in one tab: the page tree, the open documents, and the actions on them.
// All writes go through the core client (one committed transaction each); this class only decides WHAT to write.
import { normalizeFa } from '@nevis/editor'
import { DocHandle, buildTree, createDatabase, createPage, isInside, movePage, readStructured, renamePage, restorePage, trashPage, type Client, type PageNode, type PageRow, type PageTree, type Structured } from '@nevis/core'
import { SyncRuntime } from './runtime'

export interface WsStatus {
  leader: boolean
  /** the browser reports a network and the last sync round did not fail */
  online: boolean
  /** local changes the server has not confirmed yet */
  outbox: number
  /** keystrokes not yet written to the local database (at most ~300 ms of typing) */
  unsaved: number
  lastSyncAt: number
  persisted: boolean | null
  lastError: string
}

const TITLE_THROTTLE_MS = 400

export class Workspace {
  readonly rt: SyncRuntime
  tree: PageTree = buildTree([])
  /** everything structured (databases, rows, tags...) as of the last reload */
  data: Structured = { pages: [], databases: new Map(), tags: [], savedSearches: [], settings: {}, pageTags: new Map() }
  private readonly handles = new Map<string, DocHandle>()
  /** documents whose last edit was too large to save: read-only until reopened from the store (what came after it was never saved) */
  readonly diverged = new Set<string>()
  /** a short message for the person (from the editor: an image placeholder, a drawing that was too large) */
  notice = ''
  /** the view that shows pages sets this: a page link was clicked */
  onOpenPage: ((id: string) => void) | null = null
  private readonly templates = new Map<string, unknown>()
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reopens = new Map<string, number>()
  private readonly titles = new Map<string, { value: string; timer: ReturnType<typeof setTimeout> | null }>()
  private readonly listeners = new Set<() => void>()
  private reloading: Promise<void> | null = null
  private again = false

  constructor(ws: string, token: string | null) {
    this.rt = new SyncRuntime({
      ws, token,
      onChange: () => this.emit(),
      onApplied: () => void this.afterRemote(),
      onRemoteChange: m => void this.afterRemote(m.docs),
    })
  }

  get ws() { return this.rt.ws }

  async start() {
    await this.rt.start()
    await this.reload()
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => void this.listeners.delete(fn) }
  private emit() { for (const f of this.listeners) f() }

  /** Re-reads the page list (one bulk read) and rebuilds the tree. Overlapping calls collapse into one more run. */
  reload(): Promise<void> {
    if (this.reloading) { this.again = true; return this.reloading }
    this.reloading = (async () => {
      do {
        this.again = false
        this.data = await readStructured(this.rt.store)
        this.tree = buildTree(this.data.pages)
        this.emit()
      } while (this.again)
    })().finally(() => { this.reloading = null })
    return this.reloading
  }

  /** What arrived from the server or from another tab: reload the list and the open documents. */
  private async afterRemote(docs?: string[]) {
    await this.reload()
    for (const [id, h] of this.handles) if (!docs || docs.includes(id)) await h.refresh().catch(e => this.fail(e))
    this.emit()
  }

  private fail(e: unknown) { this.rt.lastError = String((e as Error).message ?? e); this.emit() }
  private async wrote(id: string) { this.rt.written({ ents: [id] }); await this.reload() }

  /** Runs a write on the client (a domain function of the core), tells the other tabs and refreshes the view. */
  async mutate<T>(ents: string[], fn: (c: Client) => Promise<T>): Promise<T> {
    const out = await fn(this.rt.client)
    this.rt.written({ ents })
    await this.reload()
    return out
  }

  async newDatabase(parent = ''): Promise<string> {
    const sibs = this.children(parent)
    const { id } = await this.mutate([], c => createDatabase(c, { parent, before: sibs.length ? sibs[sibs.length - 1]!.page.sortKey : null }))
    return id
  }

  // ---- pages ----
  children(parent: string): PageNode[] { return parent === '' ? this.tree.roots : (this.tree.byId.get(parent)?.children ?? []) }

  async newPage(parent = '', title = ''): Promise<string> {
    const sibs = this.children(parent)
    const id = await createPage(this.rt.client, { parent, title, before: sibs.length ? sibs[sibs.length - 1]!.page.sortKey : null })
    await this.wrote(id)
    return id
  }

  /** A new page whose body starts from a template (a NEW id: building a document from JSON is allowed only for those, ADR-0003 §7). */
  async newTemplatePage(title: string, content: unknown): Promise<string> {
    const id = await this.newPage('', title)
    this.templates.set(id, content)
    return id
  }
  takeTemplate(id: string): unknown { const c = this.templates.get(id); this.templates.delete(id); return c }

  /** The title is written at most every 400 ms while it is being typed. */
  setTitle(id: string, value: string) {
    const cur = this.titles.get(id)
    if (cur) { cur.value = value; return }
    const entry = { value, timer: setTimeout(() => void this.flushTitle(id), TITLE_THROTTLE_MS) as ReturnType<typeof setTimeout> | null }
    this.titles.set(id, entry)
  }
  private async flushTitle(id: string) {
    const t = this.titles.get(id)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    this.titles.delete(id)
    await renamePage(this.rt.client, id, t.value)
    await this.wrote(id)
  }

  /** Puts a page at `index` among the children of `parent`. Refuses a move into itself or its own subtree. */
  async moveTo(id: string, parent: string, index: number): Promise<boolean> {
    if (parent === id || (parent !== '' && isInside(this.tree, id, parent))) return false
    const sibs = this.children(parent).filter(n => n.page.id !== id)
    const i = Math.max(0, Math.min(index, sibs.length))
    await movePage(this.rt.client, id, parent, sibs[i - 1]?.page.sortKey ?? null, sibs[i]?.page.sortKey ?? null)
    await this.wrote(id)
    return true
  }
  private place(id: string) {
    const parent = this.tree.parentOf.get(id) ?? ''
    const sibs = this.children(parent)
    return { parent, sibs, index: sibs.findIndex(n => n.page.id === id) }
  }
  moveUp(id: string) { const p = this.place(id); return p.index > 0 ? this.moveTo(id, p.parent, p.index - 1) : Promise.resolve(false) }
  moveDown(id: string) { const p = this.place(id); return p.index >= 0 && p.index < p.sibs.length - 1 ? this.moveTo(id, p.parent, p.index + 1) : Promise.resolve(false) }
  /** Becomes the last child of the previous sibling. */
  indent(id: string) { const p = this.place(id); const prev = p.sibs[p.index - 1]; return prev ? this.moveTo(id, prev.page.id, this.children(prev.page.id).length) : Promise.resolve(false) }
  /** Becomes the next sibling of its parent. */
  outdent(id: string) {
    const parent = this.tree.parentOf.get(id) ?? ''
    if (parent === '') return Promise.resolve(false)
    const gp = this.place(parent)
    return this.moveTo(id, gp.parent, gp.index + 1)
  }
  async trash(id: string) { await trashPage(this.rt.client, id); await this.wrote(id) }
  async restore(id: string) { await restorePage(this.rt.client, id); await this.wrote(id) }

  // ---- documents ----
  async openDoc(id: string): Promise<DocHandle> {
    const have = this.handles.get(id)
    if (have) return have
    const h = await DocHandle.open({ client: this.rt.client, doc: id, onLocalWrite: d => this.rt.written({ docs: [d] }), onError: e => this.fail(e), onTooLarge: () => { this.diverged.add(id); this.emit() } })
    this.handles.set(id, h)
    return h
  }
  /** The newest pages and databases (not trashed), without sorting the whole list: one pass keeping the best `n`. */
  recent(n: number): PageRow[] {
    const top: PageRow[] = []
    for (const p of this.data.pages) {
      if (p.trashed) continue
      if (top.length < n || p.createdAt > top[top.length - 1]!.createdAt) {
        let i = top.length
        while (i > 0 && top[i - 1]!.createdAt < p.createdAt) i--
        top.splice(i, 0, p)
        if (top.length > n) top.pop()
      }
    }
    return top
  }
  /** Pages and databases whose title contains `query` (Persian-aware), at most `limit`; one pass, no index (search is M10). */
  searchTitles(query: string, limit: number): PageRow[] {
    const q = normalizeFa(query).trim()
    const out: PageRow[] = []
    for (const p of this.data.pages) {
      if (p.trashed) continue
      if (!q || normalizeFa(p.title).includes(q)) { out.push(p); if (out.length >= limit) break }
    }
    return out
  }
  /** One screenful of the "all pages" table: filtered, newest first, `size` rows from `offset`; `total` is the number of matches. */
  pageSlice(query: string, offset: number, size: number): { rows: PageRow[]; total: number } {
    const q = normalizeFa(query).trim()
    const rows = this.data.pages.filter(p => !p.trashed && (!q || normalizeFa(p.title).includes(q)))
    rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    return { rows: rows.slice(offset, offset + size), total: rows.length }
  }

  /** Pages and databases a link may point to. */
  pageList(): { id: string; title: string }[] { return this.data.pages.filter(p => !p.trashed).map(p => ({ id: p.id, title: p.title })) }
  notify(message: string) {
    this.notice = message
    this.emit()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => { this.notice = ''; this.emit() }, 6000)
  }

  /** A new count for the editor's `key`, so that it is rebuilt from what the store holds. */
  reopenCount(id: string): number { return this.reopens.get(id) ?? 0 }
  async reopenDoc(id: string) {
    await this.closeDoc(id)
    this.diverged.delete(id)
    this.reopens.set(id, this.reopenCount(id) + 1)
    this.rt.lastError = ''
    this.emit()
  }
  async closeDoc(id: string) {
    const h = this.handles.get(id)
    if (!h) return
    this.handles.delete(id)
    await h.close()
  }

  /** On `visibilitychange` (hidden), `pagehide` and close: write everything that is still waiting. Never throws. */
  flushAll(): Promise<unknown> {
    const jobs: Promise<unknown>[] = [...this.handles.values()].map(h => h.flush())
    for (const id of [...this.titles.keys()]) jobs.push(this.flushTitle(id))
    return Promise.allSettled(jobs)
  }

  async status(): Promise<WsStatus> {
    const outbox = await this.rt.store.run(async tx => (await tx.listOutbox(1_000_000)).length)
    return {
      leader: this.rt.coord?.isLeader ?? false,
      online: navigator.onLine && !this.rt.offline && !this.rt.lastError,
      outbox,
      unsaved: [...this.handles.values()].reduce((n, h) => n + h.unsaved, 0) + this.titles.size,
      lastSyncAt: this.rt.lastSyncAt,
      persisted: this.rt.persisted,
      lastError: this.rt.lastError,
    }
  }

  async stop() {
    await this.flushAll()
    this.rt.stop()
    for (const id of [...this.handles.keys()]) await this.closeDoc(id)
  }
}
