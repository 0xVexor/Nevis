import { normalizeFa } from './normalize'
import { addVersion, allPages, deleteVersions, isTauri, listVersions, savePages, vaultStamp } from './db'

const WATCH_EVERY = 3000 // how often the vault folder is checked for changes made by the sync tool

export type PageKind = 'page' | 'folder' | 'board' | 'todo'
export type PageStatus = 'todo' | 'doing' | 'done'
export type Cover = { kind: 'gradient'; id: string } | { kind: 'image'; file: string } // image = content-addressed attachment id

export interface Page {
  id: string
  parentId: string | null
  kind?: PageKind // absent = page; a folder only groups other pages and has no content of its own; a board is a page that is one whole drawing
  title: string
  icon?: string
  cover?: Cover
  titleDir?: 'rtl' | 'ltr'
  tags?: string[]
  status?: PageStatus
  favorite: boolean
  sort: number // order among siblings (becomes sort_key in SQLite, see ADR-0002)
  content: any // TipTap JSON doc
  updatedAt: number
  deletedAt: number | null
  database?: any // present when the page is a database row (src/database); the editor never touches it
  recordMeta?: any // revision / provenance of the record, see src/database/model/types.ts
  dbHost?: string // id of the database container this page is the home of (src/database)
}

type Patch = Partial<Pick<Page, 'title' | 'icon' | 'cover' | 'titleDir' | 'tags' | 'status' | 'favorite' | 'content' | 'parentId'>>

/** Page boundary: canonical vault files on desktop, IndexedDB in the browser. */
export interface PageRepo {
  init(): Promise<void>
  flushBeforeUpdate(): Promise<void>
  refreshFromStore(): Promise<boolean>
  list(): Page[] // pages and folders
  pagesOnly(): Page[] // without folders
  get(id: string): Page | undefined
  create(parentId: string | null, kind?: PageKind): Page
  update(id: string, patch: Patch, opts?: { history?: boolean }): void // history: false = this edit is machine-made (import, link fix-up) and leaves no history entry
  remove(id: string): void // soft delete, includes descendants
  search(query: string): Page[]
  backlinks(id: string): Page[] // pages that contain a pageLink to `id`
  linkGraph(): { nodes: Page[]; edges: [string, string][] } // pages and the page links between them
  move(id: string, parentId: string | null, beforeId: string | null): boolean // beforeId null = append
  trash(): Page[] // roots of deleted subtrees, newest first
  restoreFromTrash(id: string): void
  purge(id: string): void // permanent, includes descendants
  emptyTrash(): void
  autoPurge(maxAgeMs: number): number // permanently drops trash roots older than this; returns count
  dump(): Page[] // everything, including trash
  restore(pages: Page[]): void // replace everything
}

const LEGACY_KEY = 'not.pages.v1' // the localStorage era; migrated once, then removed
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

function readLegacy(): Page[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    const rows = raw ? JSON.parse(raw) : null
    return Array.isArray(rows) && rows.length ? rows : null
  } catch {
    return null
  }
}

export class Repo implements PageRepo {
  private pages: Page[] = []
  private dirty = new Set<string>()
  private gone = new Set<string>()
  private full = false
  private timer = 0
  private queue: Promise<void> = Promise.resolve()
  private persistenceError: unknown = null
  private lastSnap = new Map<string, number>()
  /** `updatedAt` of every page as last read from or written to the vault folder: the version our next edit of it starts from. */
  private diskAt = new Map<string, number>()

  private seed: () => Page[]
  constructor(seed: () => Page[]) {
    this.seed = seed
  }

  // ───── persistence ─────

  async init() {
    let rows: Page[] = []
    try {
      rows = await allPages()
    } catch (e) {
      this.fail(e)
      throw e // A read failure is not an empty workspace; never seed over unreadable data.
    }
    if (!rows.length) {
      const legacy = readLegacy()
      this.pages = legacy ?? this.seed()
      this.rebuildLinks()
      this.full = true
      await this.writeNow()
      if (legacy) {
        // remove the old copy only once the new store demonstrably holds everything
        try {
          if ((await allPages()).length === legacy.length) localStorage.removeItem(LEGACY_KEY)
        } catch {
          /* keep the legacy copy */
        }
      }
    } else {
      this.pages = rows
      this.noteDisk(rows)
      this.rebuildLinks()
    }
    navigator.storage?.persist?.().catch(() => {})
  }

  private noteDisk(rows: Page[]) {
    this.diskAt = new Map(rows.map((r) => [r.id, r.updatedAt]))
  }

  private fail(e: unknown) {
    console.error('storage error', e)
    window.dispatchEvent(new CustomEvent('storage-error', { detail: String(e) }))
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
    if (this.timer) return
    this.timer = window.setTimeout(() => {
      this.timer = 0
      void this.writeNow()
    }, 0)
  }

  /** Batches everything changed in the current tick into one IndexedDB transaction. */
  private writeNow(): Promise<void> {
    const full = this.full
    const byId = new Map(this.pages.map((p) => [p.id, p]))
    const upserts = full ? this.pages.slice() : [...this.dirty].map((id) => byId.get(id)).filter((p): p is Page => !!p)
    const removed = full ? [] : [...this.gone]
    this.dirty.clear()
    this.gone.clear()
    this.full = false
    if (!full && !upserts.length && !removed.length) return this.queue
    this.queue = this.queue
      // desktop: tell the vault which version each edit started from, so that a newer version brought by the sync is kept in the history, not overwritten
      .then(() => savePages(isTauri && !full ? upserts.map((p) => ({ ...p, _base: this.diskAt.get(p.id) ?? null })) : upserts, removed, full))
      .then(async () => {
        this.persistenceError = null
        window.dispatchEvent(new CustomEvent('storage-saved', { detail: upserts.map((p) => p.id) }))
        for (const p of upserts) this.diskAt.set(p.id, p.updatedAt)
        if (isTauri) this.stamp = await vaultStamp() // our own writes are not "external" changes
      })
      .catch((e) => {
        this.persistenceError = e
        // Keep failed writes pending so they can be retried before installation.
        if (full) this.full = true
        for (const p of upserts) if (!this.gone.has(p.id)) this.dirty.add(p.id)
        for (const id of removed) if (!this.dirty.has(id)) this.gone.add(id)
        this.fail(e)
      })
    window.dispatchEvent(new Event('data-changed'))
    return this.queue
  }

  // ───── changes made by other devices (the vault folder is synced by a drive client) ─────

  private stamp = ''
  private polling = false

  /** Desktop app: reload pages when the sync tool changes the vault, as long as there is nothing unsaved here. */
  async watch() {
    if (!isTauri) return
    this.stamp = await vaultStamp()
    window.setInterval(() => !document.hidden && void this.poll(), WATCH_EVERY) // nothing to refresh while the window is not shown; the next tick catches up
    // the sync brought another device's change: show it now instead of at the next tick
    void import('@tauri-apps/api/event').then(({ listen }) => listen('vault-changed', () => void this.poll())).catch(() => {})
    window.addEventListener('focus', () => void this.poll())
  }

  private idle = () => !this.dirty.size && !this.gone.size && !this.full

  private async poll() {
    if (this.polling || !this.idle()) return
    this.polling = true
    try {
      await this.queue
      if ((await vaultStamp()) === this.stamp) return
      const rows = await allPages() // also merges conflict copies, which changes the folder again
      if (!this.idle()) return // edited meanwhile: try again next round (the stamp is still different)
      const old = new Map(this.pages.map((p) => [p.id, p]))
      const changed = rows.filter((r) => JSON.stringify(old.get(r.id)) !== JSON.stringify(r))
      const removed = this.pages.length + changed.filter((c) => !old.has(c.id)).length - rows.length
      this.pages = rows
      this.noteDisk(rows)
      this.rebuildLinks()
      this.stamp = await vaultStamp()
      if (changed.length || removed) window.dispatchEvent(new CustomEvent('external-change', { detail: changed.map((c) => c.id) }))
    } catch (e) {
      console.error('vault watch', e)
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
      id: crypto.randomUUID(),
      parentId,
      ...(kind === 'folder' || kind === 'board' || kind === 'todo' ? { kind } : {}),
      title: '',
      favorite: false,
      sort: sibs.length ? Math.max(...sibs.map((s) => s.sort)) + 1 : 0,
      content: kind === 'board' ? EMPTY_BOARD : kind === 'todo' ? EMPTY_TODO : EMPTY_DOC,
      updatedAt: Date.now(),
      deletedAt: null,
    }
    this.pages.push(page)
    this.touch(page.id)
    return page
  }

  update(id: string, patch: Patch, opts?: { history?: boolean }) {
    const p = this.pages.find((x) => x.id === id)
    if (!p) return
    if (patch.content !== undefined && opts?.history !== false) this.snapshot(p)
    Object.assign(p, patch, { updatedAt: Date.now() })
    if (p.database) p.recordMeta = { ...(p.recordMeta ?? { format: 1, revision: 0, createdAt: p.updatedAt, createdBy: '', updatedBy: '', lastOperationId: '', inferred: true }), revision: (p.recordMeta?.revision ?? 0) + 1 } // row edits through the editor are revisions too
    if (patch.content !== undefined) this.indexLinks(p)
    this.touch(id)
  }

  /** History: keep the state a page had *before* an edit burst, at most once per SNAPSHOT_EVERY. */
  private snapshot(p: Page) {
    const old = p.content
    if (p.kind === 'folder' || !old || typeof old === 'string' || isBlankDoc(old)) return
    const now = Date.now()
    if (now - (this.lastSnap.get(p.id) ?? 0) < SNAPSHOT_EVERY) return
    this.lastSnap.set(p.id, now)
    const json = JSON.stringify(old)
    const copy = structuredClone(old)
    void listVersions(p.id)
      .then((vs) => (vs[0] && JSON.stringify(vs[0].content) === json ? undefined : addVersion({ pageId: p.id, ts: now, title: p.title, content: copy })))
      .catch((e) => console.error('history', e))
  }

  remove(id: string) {
    const now = Date.now()
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
    page.updatedAt = Date.now()
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
    gone.forEach((g) => void deleteVersions(g).catch(() => {}))
  }

  emptyTrash() {
    this.trash().forEach((p) => this.purge(p.id))
  }

  autoPurge(maxAgeMs: number): number {
    const old = this.trash().filter((p) => Date.now() - p.deletedAt! > maxAgeMs)
    old.forEach((p) => this.purge(p.id))
    return old.length
  }

  dump = () => structuredClone(this.pages)

  restore(pages: Page[]) {
    this.pages = structuredClone(pages)
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
        this.diskAt.set(u.id, u.updatedAt)
      } else {
        this.pages.push(u)
        idx.set(u.id, u)
        this.rawIdxLen = this.pages.length
        this.dirty.delete(u.id)
        this.diskAt.set(u.id, u.updatedAt)
        if (u.content !== undefined) this.indexLinks(u)
      }
    }
    if (removed.length) {
      const gone = new Set(removed)
      this.pages = this.pages.filter((p) => !gone.has(p.id))
      gone.forEach((g) => (this.unindexLinks(g), this.dirty.delete(g)))
    }
    window.dispatchEvent(new Event('data-changed'))
  }

  /** Another tab / device changed the stored pages: read them again, unless there are unsaved edits here (then the next poll retries). */
  async refreshFromStore(): Promise<boolean> {
    if (!this.idle()) return false
    await this.queue
    const rows = await allPages()
    if (!this.idle()) return false
    const old = new Map(this.pages.map((p) => [p.id, p]))
    const changed = rows.filter((r) => JSON.stringify(old.get(r.id)) !== JSON.stringify(r))
    this.pages = rows
    this.noteDisk(rows)
    this.rebuildLinks()
    window.dispatchEvent(new CustomEvent('external-change', { detail: changed.map((c) => c.id) }))
    return true
  }
}

export const WELCOME_DOC = `
<h1>یادداشت درس جاوا</h1>
<p>متغیر <code>count</code> را از نوع int تعریف کنید و مقدار 10 بدهید.</p>
<p>This is an English paragraph with فارسی in the middle و عدد 123.</p>
<p>برای شروع، در یک خط جدید <code>/</code> بزنید تا منوی بلاک‌ها باز شود.</p>
<ul><li>مورد اول</li><li>Second item</li><li>مورد سوم با English</li></ul>
<table dir="rtl"><tbody>
<tr><th>مفهوم</th><th>Concept</th><th>توضیح</th></tr>
<tr><td>کلاس</td><td>Class</td><td>قالب ساخت شیء</td></tr>
<tr><td>شیء</td><td>Object</td><td>نمونه‌ای از کلاس</td></tr>
</tbody></table>
<pre><code class="language-java">public class Main {
  public static void main(String[] args) {
    System.out.println("سلام دنیا");
  }
}</code></pre>
`
