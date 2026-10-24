import { normalizeFa } from './normalize'
import { addVersion, allPages, deleteVersions, isTauri, listVersions, savePages, vaultStamp } from './db'

const WATCH_EVERY = 3000 // how often the vault folder is checked for changes made by the sync tool

type PageKind = 'page' | 'folder'
export type PageStatus = 'todo' | 'doing' | 'done'
export type Cover = { kind: 'gradient'; id: string } | { kind: 'image'; file: string } // image = content-addressed attachment id

export interface Page {
  id: string
  parentId: string | null
  kind?: PageKind // absent = page; a folder only groups other pages and has no content of its own
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
}

type Patch = Partial<Pick<Page, 'title' | 'icon' | 'cover' | 'titleDir' | 'tags' | 'status' | 'favorite' | 'content' | 'parentId'>>

/** Storage boundary. IndexedDB today; SQLite (ADR-0002) later, same shape. */
export interface PageRepo {
  init(): Promise<void>
  list(): Page[] // pages and folders
  pagesOnly(): Page[] // without folders
  get(id: string): Page | undefined
  create(parentId: string | null, kind?: PageKind): Page
  update(id: string, patch: Patch): void
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
  private lastSnap = new Map<string, number>()

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
      this.rebuildLinks()
    }
    navigator.storage?.persist?.().catch(() => {})
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
      .then(() => savePages(upserts, removed, full))
      .then(async () => {
        if (isTauri) this.stamp = await vaultStamp() // our own writes are not "external" changes
      })
      .catch((e) => this.fail(e))
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
    window.setInterval(() => void this.poll(), WATCH_EVERY)
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
      const changed = rows.filter((r) => old.get(r.id)?.updatedAt !== r.updatedAt || old.get(r.id)?.deletedAt !== r.deletedAt)
      const removed = this.pages.length + changed.filter((c) => !old.has(c.id)).length - rows.length
      this.pages = rows
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
      ...(kind === 'folder' ? { kind } : {}),
      title: '',
      favorite: false,
      sort: sibs.length ? Math.max(...sibs.map((s) => s.sort)) + 1 : 0,
      content: EMPTY_DOC,
      updatedAt: Date.now(),
      deletedAt: null,
    }
    this.pages.push(page)
    this.touch(page.id)
    return page
  }

  update(id: string, patch: Patch) {
    const p = this.pages.find((x) => x.id === id)
    if (!p) return
    if (patch.content !== undefined) this.snapshot(p)
    Object.assign(p, patch, { updatedAt: Date.now() })
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
