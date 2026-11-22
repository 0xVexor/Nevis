// The notes app's state for one workspace in one tab: the page tree, the open documents, and the actions on them.
// All writes go through the core client (one committed transaction each); this class only decides WHAT to write.
import { normalizeFa } from '@nevis/editor'
import { AUTO_AFTER_MS, DocHandle, addVersion, foldSchedules, loadDoc, readVersions, thinVersions, type Version, reviewCard, reviewTimes, type Grade, type Rec, type BlobStatus, buildTree, createDatabase, createPage, isInside, movePage, readStructured, renamePage, restorePage, setPageMeta, createTag, tagPage, trashPage, setSetting, type Client, type PageNode, type PageRow, type PageTree, type Structured } from '@nevis/core'
import { exportBundle, importBundle, mdFileName, toMarkdown, type ImportResult } from '@nevis/bundle'
import * as Y from 'yjs'
import { BODY, project, uuidv7, writeBody, type PMJson } from '@nevis/schema'
import { SV } from '@nevis/protocol'
import { zipSync, strToU8, type Zippable } from 'fflate'
import { Mirror, mirrorFolder } from './mirror'
import { isDesktop } from './desktop'
import { SyncRuntime } from './runtime'
import { SearchService } from './search/service'
import { t } from './i18n'

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
  /** this app is too old for the workspace: it must be reloaded/updated (HTTP 426) */
  upgradeRequired: boolean
  /** attachments: files waiting to upload, progress, and why uploading stopped */
  files: BlobStatus
}

const TITLE_THROTTLE_MS = 400

export class Workspace {
  readonly rt: SyncRuntime
  readonly search: SearchService
  /** the Markdown mirror (desktop only; set from Settings) */
  mirror: Mirror | null = null
  tree: PageTree = buildTree([])
  /** everything structured (databases, rows, tags...) as of the last reload */
  data: Structured = { pages: [], databases: new Map(), tags: [], savedSearches: [], settings: {}, pageTags: new Map() }
  private readonly handles = new Map<string, DocHandle>()
  private readonly opening = new Map<string, Promise<DocHandle>>()
  private readonly closing = new Map<string, Promise<void>>()
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
      onApplied: s => { this.search.dirty(s.docs ?? []); this.mirror?.touch(s.docs ?? []); void this.afterRemote() },
      onRemoteChange: m => void this.afterRemote(m.docs),
    })
    this.search = new SearchService(this.rt.store)
    this.search.onChange = () => this.emit()
  }

  get ws() { return this.rt.ws }

  async start() {
    await this.rt.start()
    await this.reload()
    void this.search.start(this.data.pages)
    if (isDesktop && mirrorFolder(this.ws)) this.startMirror(mirrorFolder(this.ws))
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
        this.search.setPages(this.data.pages)
        this.mirror?.touch()
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
  async wrote(id: string) { this.rt.written({ ents: [id] }); await this.reload() }

  /** Runs a write on the client (a domain function of the core), tells the other tabs and refreshes the view. */
  async mutate<T>(ents: string[], fn: (c: Client) => Promise<T>): Promise<T> {
    const out = await fn(this.rt.client)
    this.rt.written({ ents })
    await this.reload()
    return out
  }

  async newDatabase(parent = ''): Promise<string> {
    const sibs = this.children(parent)
    const { id } = await this.mutate([], c => createDatabase(c, { parent, before: sibs.length ? sibs[sibs.length - 1]!.page.sortKey : null, titlePropertyName: t('Name'), viewName: t('Table') }))
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
  /** Replaces the body of a page with `json` (the Home note: a draft that becomes a page on its first words, then keeps being saved). */
  async writeBody(id: string, json: PMJson): Promise<void> {
    const h = await this.openDoc(id)
    try { writeBody(h.ydoc, json); await h.flush() } finally { await this.closeDoc(id) }
  }
  /** The schedule of every reviewed card and the times of all reviews (a fold over the review events). */
  async reviewData(): Promise<{ recs: Map<string, Rec>; times: number[] }> {
    const events = await this.rt.store.run(tx => tx.allEvents())
    return { recs: foldSchedules(events), times: reviewTimes(events) }
  }
  async rateCard(card: string, grade: Grade, durationMs: number) {
    await reviewCard(this.rt.client, card, grade, Date.now(), durationMs)
    this.rt.written({ ents: [card] })
  }
  // ---- export and import (ADR-0009): the person's data, in open formats ----
  private async attachment(hash: string) {
    const data = await this.rt.blobSync.fetch(hash)
    return data ? { data, mime: (await this.rt.blobs.meta(hash))?.mime ?? '' } : undefined
  }
  /** The lossless bundle (`*.nevis.zip`). */
  async exportBundle(): Promise<Uint8Array> {
    await Promise.all([...this.handles.values()].map(h => h.flush()))
    for (const id of [...this.titles.keys()]) await this.flushTitle(id)
    return exportBundle({ store: this.rt.store, workspace: { id: this.ws, name: '' }, sv: SV, blob: h => this.attachment(h) })
  }
  /** The Markdown file of one page: its path in the tree (folders are the parents' file names) and its text. `refs` collects the attachments it names. */
  async markdownOf(id: string, refs: Set<string> = new Set()): Promise<{ path: string; text: string }> {
    await this.handles.get(id)?.flush()
    await this.flushTitle(id)
    const byId = new Map(this.data.pages.map(p => [p.id, p]))
    const dirOf = (pid: string, guard = 0): string => { const p = byId.get(pid); return p && p.parent && byId.has(p.parent) && guard < 50 ? `${dirOf(p.parent, guard + 1)}${mdFileName(byId.get(p.parent)!.title, p.parent).replace(/\.md$/, '')}/` : '' }
    const p = byId.get(id)!
    const folder = dirOf(id)
    const json = project(await this.rt.store.run(tx => loadDoc(tx, id)))
    const up = '../'.repeat(folder.split('/').filter(Boolean).length)
    const text = toMarkdown(json, { titleOf: x => byId.get(x)?.title ?? '', attachment: h => { refs.add(h); return `${up}attachments/${h}` } }, { id, title: p.title, parent: p.parent, created: p.createdAt })
    return { path: `${folder}${mdFileName(p.title, id)}`, text }
  }
  /** A zip of Markdown files laid out as the page tree, with the attachments next to them. One way: nothing is read back from it. */
  async exportMarkdown(): Promise<Uint8Array> {
    const files: Zippable = {}
    const refs = new Set<string>()
    for (const p of this.data.pages.filter(x => !x.trashed && x.type !== 'database' && !this.isFolder(x.id))) { const f = await this.markdownOf(p.id, refs); files[f.path] = strToU8(f.text) }
    for (const h of refs) { const a = await this.attachment(h); if (a) files[`attachments/${h}`] = [new Uint8Array(await a.data.arrayBuffer()), { level: 0 }] }
    return zipSync(files)
  }
  startMirror(dir: string) { this.mirror?.stop(); this.mirror = dir ? new Mirror(this, dir) : null; this.mirror?.touch() }
  /** Imports a bundle into THIS (new) workspace. */
  async importBundle(zip: Uint8Array): Promise<ImportResult> {
    const r = await importBundle(zip, { client: this.rt.client, store: this.rt.store, blobs: this.rt.blobs })
    this.rt.written({})
    await this.reload()
    return r
  }

  // ---- page history (versions are events about the page; see packages/core/src/versions.ts) ----
  private readonly versionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The page as it is stored now, as JSON text. */
  private async bodyJson(id: string): Promise<string> { return JSON.stringify(project(await this.rt.store.run(tx => loadDoc(tx, id)))) }
  /** The versions to show: thinned by the rule of ROADMAP M11, newest first. */
  async versions(id: string): Promise<Version[]> {
    return thinVersions(readVersions(await this.rt.store.run(tx => tx.allEvents()), id), Date.now())
  }
  /** Saves the page's current state as a version (a manual one is kept for ever). Nothing is written if it equals the newest version. */
  async saveVersion(id: string, manual = false, label = ''): Promise<boolean> {
    const json = await this.bodyJson(id)
    const last = readVersions(await this.rt.store.run(tx => tx.allEvents()), id)[0]
    if (!manual && last?.json === json) return false
    if (!(await addVersion(this.rt.client, id, json, { at: Date.now(), manual, label }))) return false
    this.rt.written({ ents: [id] })
    return true
  }
  /** Restoring is an ordinary edit: the current state is saved as a version first, then the old body is written in one transaction. */
  async restoreVersion(id: string, version: Version) {
    await this.saveVersion(id, true, 'قبل از بازگردانی')
    await this.writeBody(id, JSON.parse(version.json) as PMJson)
  }
  /** A version 5 minutes after the last edit of a page. */
  private scheduleVersion(id: string) {
    clearTimeout(this.versionTimers.get(id))
    this.versionTimers.set(id, setTimeout(() => { this.versionTimers.delete(id); void this.saveVersion(id).catch(() => undefined) }, AUTO_AFTER_MS))
  }
  takeTemplate(id: string): unknown { const c = this.templates.get(id); this.templates.delete(id); return c }

  /** The title is written at most every 400 ms while it is being typed. */
  setTitle(id: string, value: string) {
    const cur = this.titles.get(id)
    if (cur) { cur.value = value; return }
    const entry = { value, timer: setTimeout(() => void this.flushTitle(id), TITLE_THROTTLE_MS) as ReturnType<typeof setTimeout> | null }
    this.titles.set(id, entry)
  }
  /** Dialog actions commit immediately, replacing any title still waiting from the editor. */
  async rename(id: string, value: string) {
    this.setTitle(id, value)
    await this.flushTitle(id)
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
  /** Permanent deletion of a page and everything under it (the trash's "Delete permanently"). Cannot be undone, on any device. */
  async purge(id: string): Promise<void> {
    const kids = new Map<string, string[]>()
    for (const p of this.data.pages) { const l = kids.get(p.parent) ?? []; l.push(p.id); kids.set(p.parent, l) }
    const all: string[] = []
    const walk = (x: string, depth = 0) => { all.push(x); if (depth < 200) for (const c of kids.get(x) ?? []) walk(c, depth + 1) }
    walk(id)
    for (const x of all) await this.rt.client.purge(x)
    this.rt.written({ ents: all })
    await this.reload()
  }
  async emptyTrash(): Promise<void> { for (const p of [...this.tree.trash]) await this.purge(p.id) }
  /** Ticks (or unticks) a checklist item of a page, found by its block id, in one Yjs transaction: the page itself changes. */
  /** `ordinal` (the item's place among the page's checklist items) is used only for an item that has no block id yet: a page written before it was ever edited. */
  async setTaskChecked(page: string, blockId: string, checked: boolean, ordinal = -1): Promise<void> {
    const h = await this.openDoc(page)
    try {
      h.ydoc.transact(() => {
        let seen = 0
        const walk = (n: Y.XmlFragment | Y.XmlElement): boolean => {
          for (const c of n.toArray() as (Y.XmlElement | Y.XmlText)[]) {
            if (!('nodeName' in c)) continue // text (duck typing: another copy of Yjs in the bundle would fail `instanceof`)
            if (c.nodeName === 'taskItem') { const mine = blockId ? c.getAttribute('blockId') === blockId : seen === ordinal; seen++; if (mine) { c.setAttribute('checked', checked as never); return true } }
            if (walk(c)) return true
          }
          return false
        }
        walk(h.ydoc.getXmlFragment(BODY))
      })
      await h.flush()
    } finally { await this.closeDoc(page) }
  }
  /** The Inbox of the Tasks screen: an ordinary page (so it merges, syncs and exports like any other) that the settings name and the tree hides. */
  inboxId(): string | undefined { const v = this.data.settings.inbox; return typeof v === 'string' && this.data.pages.some(p => p.id === v) ? v : undefined }
  async ensureInbox(): Promise<string> {
    const have = this.inboxId(); if (have) return have
    const id = await createPage(this.rt.client, { parent: '', title: 'صندوق ورودی' })
    await this.mutate([this.ws], c => setSetting(c, 'inbox', id))
    await this.wrote(id)
    return id
  }
  /** A board: a page that is one whole drawing (the settings mark it; one register per board, so two devices never overwrite each other). */
  isBoard(id: string): boolean { return this.data.settings[`board:${id}`] === true }
  async newBoard(parent = ''): Promise<string> {
    const id = await this.newPage(parent, '')
    await this.mutate([this.ws], c => setSetting(c, `board:${id}`, true))
    return id
  }
  isFolder(id: string): boolean { return this.data.settings[`folder:${id}`] === true }
  async newFolder(parent = '', title = ''): Promise<string> {
    const id = await this.newPage(parent, title)
    await this.mutate([this.ws], c => setSetting(c, `folder:${id}`, true))
    return id
  }
  /** A to-do list: a page the settings mark as a list (one register per list, so two devices never overwrite each other). */
  isTodoList(id: string): boolean { return this.data.settings[`list:${id}`] === true }
  async newTodoList(title: string): Promise<string> {
    const id = await this.newPage('', title)
    await this.mutate([this.ws], c => setSetting(c, `list:${id}`, true))
    return id
  }
  /** Adds a checklist item at the end of a page: into its last checklist, or a new one. One Yjs transaction. */
  async appendTask(page: string, text: string): Promise<void> {
    const h = await this.openDoc(page)
    try {
      h.ydoc.transact(() => {
        const frag = h.ydoc.getXmlFragment(BODY)
        const last = frag.length ? frag.get(frag.length - 1) : null
        const item = new Y.XmlElement('taskItem'); item.setAttribute('checked', false as never); item.setAttribute('blockId', uuidv7() as never)
        const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText(text)]); item.insert(0, [para])
        if (last && 'nodeName' in last && last.nodeName === 'taskList') (last as Y.XmlElement).insert((last as Y.XmlElement).length, [item])
        else { const list = new Y.XmlElement('taskList'); list.insert(0, [item]); frag.insert(frag.length, [list]) }
      })
      await h.flush()
    } finally { await this.closeDoc(page) }
  }
  /** Removes a checklist item (found by its block id) from a page. */
  async removeTask(page: string, blockId: string): Promise<void> {
    const h = await this.openDoc(page)
    try {
      h.ydoc.transact(() => {
        const walk = (n: Y.XmlFragment | Y.XmlElement): boolean => {
          const kids = n.toArray() as (Y.XmlElement | Y.XmlText)[]
          for (let i = 0; i < kids.length; i++) {
            const c = kids[i]!
            if (!('nodeName' in c)) continue
            if (c.nodeName === 'taskItem' && c.getAttribute('blockId') === blockId) { n.delete(i, 1); return true }
            if (walk(c)) return true
          }
          return false
        }
        walk(h.ydoc.getXmlFragment(BODY))
      })
      await h.flush()
    } finally { await this.closeDoc(page) }
  }
  /** A copy of a page (title, look and body) under `parent`, with the id the caller already handed out. */
  async duplicatePage(id: string, parent: string, newId: string): Promise<void> {
    await this.flushTitle(id)
    const src = this.data.pages.find(p => p.id === id); if (!src) return
    if (src.type === 'database') throw new Error('Database duplication requires its structured data')
    const alreadyOpen = this.handles.has(id)
    const h = await this.openDoc(id); let json: PMJson
    try { json = project(h.ydoc) } finally { if (!alreadyOpen) await this.closeDoc(id) }
    const siblings = this.children(parent)
    await createPage(this.rt.client, { parent, title: src.title, before: siblings.at(-1)?.page.sortKey ?? null }, newId)
    await this.setMeta(newId, { icon: src.icon ?? '', cover: src.cover || null, status: src.status ?? '' })
    for (const kind of ['board', 'list', 'folder']) {
      if (this.data.settings[`${kind}:${id}`] === true) await this.mutate([this.ws], c => setSetting(c, `${kind}:${newId}`, true))
    }
    for (const tid of this.data.pageTags.get(id) ?? []) await tagPage(this.rt.client, newId, tid, true)
    await this.writeBody(newId, json)
    await this.wrote(newId)
  }
  /** Adds a tag to a page (creating the tag the first time its name is used) or removes it. */
  async tagPageByName(id: string, name: string, on: boolean) {
    const key = normalizeFa(name.trim())
    if (!key) return
    let tag = this.data.tags.find(x => normalizeFa(x.name) === key)
    let tagId = tag?.id
    if (!tagId && on) tagId = await createTag(this.rt.client, { name: name.trim() })
    if (!tagId) return
    await tagPage(this.rt.client, id, tagId, on)
    this.rt.written({ ents: [id, tagId] })
    await this.reload()
  }
  /** Page metadata (status, icon, favorite): one register each. */
  async setMeta(id: string, patch: Parameters<typeof setPageMeta>[2]) { await setPageMeta(this.rt.client, id, patch); await this.wrote(id) }
  async trash(id: string) { await trashPage(this.rt.client, id); await this.wrote(id) }
  async restore(id: string) { await restorePage(this.rt.client, id); await this.wrote(id) }

  // ---- documents ----
  async openDoc(id: string): Promise<DocHandle> {
    // A fast page switch may return while the previous handle is still flushing. Read only after it finishes.
    await this.closing.get(id)
    const have = this.handles.get(id)
    if (have) return have
    let pending = this.opening.get(id)
    if (!pending) {
      pending = DocHandle.open({ client: this.rt.client, doc: id, onLocalWrite: d => { this.rt.written({ docs: [d] }); this.search.dirty([d]); this.scheduleVersion(d); this.mirror?.touch([d]) }, onError: e => this.fail(e), onTooLarge: () => { this.diverged.add(id); this.emit() } })
        .then(h => { this.handles.set(id, h); return h })
        .finally(() => this.opening.delete(id))
      this.opening.set(id, pending)
    }
    return pending
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
  pageList(): { id: string; title: string }[] { return this.data.pages.filter(p => !p.trashed && !this.isFolder(p.id)).map(p => ({ id: p.id, title: p.title })) }
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
    const pending = this.closing.get(id)
    if (pending) return pending
    const closing = (async () => {
      const h = this.handles.get(id) ?? await this.opening.get(id)
      if (!h) return
      this.handles.delete(id)
      await h.close()
    })().finally(() => this.closing.delete(id))
    this.closing.set(id, closing)
    return closing
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
      upgradeRequired: this.rt.upgradeRequired,
      files: { ...this.rt.blobStatus(), pending: (await this.rt.blobs.pending()).length },
    }
  }

  async stop() {
    await this.flushAll()
    this.search.stop()
    this.mirror?.stop()
    this.rt.stop()
    for (const id of [...this.handles.keys()]) await this.closeDoc(id)
  }
}
