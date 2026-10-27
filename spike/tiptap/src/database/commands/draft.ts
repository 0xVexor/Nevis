// Draft: a copy-on-write overlay over the committed DbState. Command handlers read and write only the draft; nothing reaches
// the state until the whole batch validated and the storage adapter made it durable.
import type { Definition, Id, PageLike, RecordKind, RelationEdge, RowExtension } from '../model/types.ts'
import { compareKeys } from '../model/ids.ts'
import type { DbState, Records, Row } from '../state.ts'
import { identifyBlocks } from '../../documents/blockIdentity.ts'

const k = (kind: RecordKind, id: Id) => `${kind}:${id}`

export class Draft {
  base: DbState
  recs = new Map<string, Records[RecordKind] | null>()
  pgs = new Map<Id, PageLike | null>()
  /** per source: live row count and last sort key, so creating many rows in one batch does not rescan every page each time */
  private stats = new Map<Id, { count: number; last: string | null }>()
  created = new Set<string>()
  constructor(base: DbState) {
    this.base = base
  }

  get vaultId() {
    return this.base.vaultId
  }

  // ───── records ─────
  get<K extends RecordKind>(kind: K, id: Id): Records[K] | undefined {
    const key = k(kind, id)
    if (this.recs.has(key)) return (this.recs.get(key) ?? undefined) as Records[K] | undefined
    return this.base.get(kind, id)
  }
  /** Working copy of an existing record (cloned once, then edited in place). */
  mut<K extends RecordKind>(kind: K, id: Id): Records[K] {
    const key = k(kind, id)
    const have = this.recs.get(key)
    if (have) return have as Records[K]
    const b = this.base.get(kind, id)
    if (!b) throw new Error(`record ${kind}/${id} not found`)
    const c = structuredClone(b)
    this.recs.set(key, c)
    return c
  }
  add<K extends RecordKind>(kind: K, rec: Records[K]): Records[K] {
    this.recs.set(k(kind, rec.id), rec)
    this.created.add(k(kind, rec.id))
    return rec
  }
  /** Remove a record file entirely (restore / purge only; normal deletion is a tombstone). */
  purge(kind: RecordKind, id: Id) {
    this.recs.set(k(kind, id), null)
  }
  all<K extends RecordKind>(kind: K): Records[K][] {
    const out = new Map<Id, Records[K]>()
    for (const r of this.base.all(kind)) out.set(r.id, r)
    for (const [key, v] of this.recs) {
      if (!key.startsWith(kind + ':')) continue
      const id = key.slice(kind.length + 1)
      if (v) out.set(id, v as Records[K])
      else out.delete(id)
    }
    return [...out.values()]
  }
  live<K extends RecordKind>(kind: K): Records[K][] {
    return this.all(kind).filter((r) => r.deletedAt === null)
  }

  // ───── pages ─────
  page(id: Id): PageLike | undefined {
    if (this.pgs.has(id)) return this.pgs.get(id) ?? undefined
    return this.base.pages.get(id)
  }
  /** Working copy of a page: the (possibly large) body is shared by reference, so handlers must replace `content`, never edit it. */
  mutPage(id: Id): PageLike {
    const have = this.pgs.get(id)
    if (have) return have
    const b = this.base.pages.get(id)
    if (!b) throw new Error(`page ${id} not found`)
    this.stats.clear()
    const c: PageLike = { ...b }
    if (b.database) c.database = structuredClone(b.database)
    if (b.recordMeta) c.recordMeta = { ...b.recordMeta }
    this.pgs.set(id, c)
    return c
  }
  addPage(p: PageLike): PageLike {
    if (p.content !== undefined) p.content = identifyBlocks(p.content).content
    this.pgs.set(p.id, p)
    const st = p.database ? this.stats.get(p.database.sourceId) : undefined
    if (st) {
      st.count++
      if (st.last === null || compareKeys(p.database!.sortKey, st.last) > 0) st.last = p.database!.sortKey
    }
    this.created.add(`page:${p.id}`)
    return p
  }
  rowStats(sourceId: Id): { count: number; last: string | null } {
    let s = this.stats.get(sourceId)
    if (!s) {
      s = { count: 0, last: null }
      for (const p of this.allPages()) {
        if (p.database?.sourceId !== sourceId || p.deletedAt !== null || p.kind === 'folder') continue
        s.count++
        if (s.last === null || compareKeys(p.database.sortKey, s.last) > 0) s.last = p.database.sortKey
      }
      this.stats.set(sourceId, s)
    }
    return s
  }
  removePage(id: Id) {
    this.stats.clear()
    this.pgs.set(id, null)
  }
  allPages(): PageLike[] {
    const out = new Map<Id, PageLike>()
    for (const p of this.base.pages.all()) out.set(p.id, p)
    for (const [id, p] of this.pgs) (p ? out.set(id, p) : out.delete(id))
    return [...out.values()]
  }

  // ───── derived views that see the overlay ─────
  row(pageId: Id): Row | undefined {
    const p = this.page(pageId)
    if (!p?.database) return undefined
    const src = this.get('source', p.database.sourceId)
    if (!src || src.deletedAt !== null) return undefined
    return { page: p, ext: p.database as RowExtension, sourceId: p.database.sourceId }
  }
  rowsOf(sourceId: Id): Row[] {
    const out: Row[] = []
    for (const p of this.allPages()) {
      if (p.database?.sourceId === sourceId && p.deletedAt === null && p.kind !== 'folder') out.push({ page: p, ext: p.database, sourceId })
    }
    return out.sort((a, b) => compareKeys(a.ext.sortKey, b.ext.sortKey) || compareKeys(a.page.id, b.page.id))
  }
  props(sourceId: Id): Definition[] {
    return this.live('property').filter((p) => p.sourceId === sourceId).sort((a, b) => compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id))
  }
  prop(id: Id): Definition | undefined {
    const p = this.get('property', id)
    return p && p.deletedAt === null ? p : undefined
  }
  relationOf(propertyId: Id) {
    return this.live('relation').find((r) => r.propertyId === propertyId || r.inversePropertyId === propertyId)
  }
  edgesOut(defId: Id, pageId: Id): RelationEdge[] {
    return this.live('edge').filter((e) => e.definitionId === defId && e.fromPageId === pageId).sort((a, b) => compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id))
  }
  edgesIn(defId: Id, pageId: Id): RelationEdge[] {
    return this.live('edge').filter((e) => e.definitionId === defId && e.toPageId === pageId).sort((a, b) => compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id))
  }
}
