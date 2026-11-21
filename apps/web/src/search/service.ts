// Search, backlinks and tasks of one workspace: DERIVED data (ADR-0010). The index is built from the pages in a Worker, kept in this
// device's store (`derived_search`, never synced) tagged with NORM_VERSION, and rebuilt whenever that does not match.
import { extractCards, loadDoc, type PageRow, type RawCard, type Store } from '@nevis/core'
import { project } from '@nevis/schema'
import { NORM_VERSION } from '@nevis/text-fa'
import { extractPage, type Hit, type PageLinkRef, type PageTask, type SearchDoc } from '@nevis/search'

const INDEX_KEY = 'derived_search'
const PAGES_KEY = 'derived_pages'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface PageInfo { title: string; links: PageLinkRef[]; tasks: PageTask[]; /** the first ~160 characters of the text */ excerpt?: string; /** when this device last saw the page change (0 = not known) */ at?: number; /** the flashcards of the page (toggle blocks) */ cards?: RawCard[]; /** words in the text */ words?: number }

export class SearchService {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, (v: unknown) => void>()
  private info = new Map<string, PageInfo>()
  private dirtyDocs = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private pages: PageRow[] = []
  /** the index answers (false while the first build runs: callers fall back to titles) */
  ready = false
  /** pages indexed / pages to index during a build */
  progress = { done: 0, total: 0 }
  rebuilt = false
  onChange: () => void = () => undefined

  private readonly store: Store
  constructor(store: Store) {
    this.store = store
    this.worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = e => { const f = this.pending.get(e.data.id); if (f) { this.pending.delete(e.data.id); f(e.data.out) } }
  }

  private call<T>(m: Record<string, unknown>): Promise<T> {
    const id = ++this.seq
    return new Promise<T>(ok => { this.pending.set(id, ok as (v: unknown) => void); this.worker.postMessage({ ...m, id }) })
  }

  /** Loads what was saved (if it matches NORM_VERSION) and brings it up to date with `pages`. */
  async start(pages: PageRow[]): Promise<void> {
    this.pages = pages
    const [text, meta] = await this.store.run(async tx => [await tx.getMeta(INDEX_KEY), await tx.getMeta(PAGES_KEY)] as const)
    let loaded = false
    if (text && meta) {
      try {
        const j = JSON.parse(meta) as { norm: number; pages: Record<string, PageInfo> }
        if (j.norm === NORM_VERSION && await this.call<boolean>({ t: 'load', text })) { this.info = new Map(Object.entries(j.pages)); loaded = true }
      } catch { /* damaged: rebuild */ }
    }
    this.rebuilt = !loaded
    this.ready = loaded
    this.onChange()
    this.schedule(0)
  }

  /** The page list changed (titles, new pages, trash): anything not indexed under its current title is refreshed. */
  setPages(pages: PageRow[]) { this.pages = pages; this.schedule(300) }
  /** Documents whose body changed (a local edit, or ops that arrived). */
  dirty(ids: string[]) { for (const id of ids) this.dirtyDocs.add(id); this.schedule(1000) }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.run() }, ms)
  }

  private run(): Promise<void> {
    return (this.running ??= this.work().finally(() => { this.running = null; if (this.dirtyDocs.size || this.stale().length) this.schedule(200) }))
  }

  private stale(): PageRow[] {
    return this.pages.filter(p => this.dirtyDocs.has(p.id) || this.info.get(p.id)?.title !== p.title)
  }

  private async work() {
    const live = new Set(this.pages.map(p => p.id))
    const gone = [...this.info.keys()].filter(id => !live.has(id))
    if (gone.length) { await this.call({ t: 'remove', ids: gone }); for (const id of gone) this.info.delete(id) }
    const todo = this.stale()
    const dirty = new Set(this.dirtyDocs)
    this.dirtyDocs.clear()
    if (!todo.length) { this.finish(gone.length > 0); return }
    this.progress = { done: 0, total: todo.length }
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40)
      const docs: SearchDoc[] = []
      for (const p of batch) {
        let text = '', links: PageLinkRef[] = [], tasks: PageTask[] = [], cards: RawCard[] = []
        if (p.type !== 'database') {
          try { const json = project(await this.store.run(tx => loadDoc(tx, p.id))); const ex = extractPage(json); text = ex.text; links = ex.links; tasks = ex.tasks; cards = extractCards(p.id, json) } catch { /* unreadable page: indexed by title only */ }
        }
        const prev = this.info.get(p.id)
        this.info.set(p.id, { title: p.title, links, tasks, cards, words: text.trim() ? text.trim().split(/\s+/).length : 0, excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 160), at: dirty.has(p.id) || p.title !== prev?.title ? Date.now() : (prev?.at ?? 0) })
        docs.push({ id: p.id, title: p.title, body: text })
      }
      await this.call({ t: 'add', docs })
      this.progress.done = Math.min(todo.length, i + batch.length)
      this.onChange()
      await sleep(0) // let the page breathe between batches
    }
    this.finish(true)
  }

  private finish(changed: boolean) {
    this.ready = true
    this.progress = { done: 0, total: 0 }
    this.onChange()
    if (changed) { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => void this.save(), 5000) }
  }

  async save(): Promise<void> {
    const text = await this.call<string>({ t: 'dump' })
    const meta = JSON.stringify({ norm: NORM_VERSION, pages: Object.fromEntries(this.info) })
    await this.store.run(async tx => { await tx.setMeta(INDEX_KEY, text); await tx.setMeta(PAGES_KEY, meta) })
  }

  /** Pages matching the query, best first (trashed pages are left out). */
  async search(q: string, limit = 20): Promise<Hit[]> {
    const hits = await this.call<Hit[]>({ t: 'search', q, limit: limit * 2 })
    const alive = new Set(this.pages.filter(p => !p.trashed).map(p => p.id))
    return hits.filter(h => alive.has(h.id)).slice(0, limit)
  }

  /** The first characters of a page's text, and when this device last saw it change (0 = not known). */
  wordsOf(id: string): number { return this.info.get(id)?.words ?? 0 }
  excerptOf(id: string): string { return this.info.get(id)?.excerpt ?? '' }
  touchedAt(id: string): number { return this.info.get(id)?.at ?? 0 }

  /** Pages that link to `id`: by the target's id, so a rename of `id` changes nothing here. */
  backlinks(id: string): string[] {
    const alive = new Set(this.pages.filter(p => !p.trashed).map(p => p.id))
    return [...this.info].filter(([src, i]) => src !== id && alive.has(src) && i.links.some(l => l.dst === id)).map(([src]) => src)
  }
  /** Every link between live pages (the graph). */
  edges(): { from: string; to: string }[] {
    const alive = new Set(this.pages.filter(p => !p.trashed).map(p => p.id))
    const out: { from: string; to: string }[] = []
    for (const [src, i] of this.info) if (alive.has(src)) for (const l of i.links) if (alive.has(l.dst) && l.dst !== src) out.push({ from: src, to: l.dst })
    return out
  }
  /** Every flashcard of every live page. */
  cards(): RawCard[] {
    const alive = new Set(this.pages.filter(p => !p.trashed).map(p => p.id))
    return [...this.info].filter(([src]) => alive.has(src)).flatMap(([, i]) => i.cards ?? [])
  }
  tasks(): { page: string; task: PageTask }[] {
    const alive = new Set(this.pages.filter(p => !p.trashed).map(p => p.id))
    return [...this.info].filter(([src]) => alive.has(src)).flatMap(([src, i]) => i.tasks.map(task => ({ page: src, task })))
  }

  stop() { if (this.timer) clearTimeout(this.timer); if (this.saveTimer) clearTimeout(this.saveTimer); this.worker.terminate() }
}
