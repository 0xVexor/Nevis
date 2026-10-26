// In-memory database state: the canonical records (loaded from the Vault / IndexedDB) plus derived indexes that are rebuilt per
// generation. Indexes are never authoritative: reverse relations, rows-per-source and sub-item children all come from here.
import type {
  Allocator, CommentRecord, Container, Definition, EventRecord, Grant, Id, PageLike, Principal, RecordKind, RelationDefinition, RelationEdge,
  RowExtension, Source, TemplateRecord, View, WorkflowRecord,
} from './model/types.ts'
import { RECORD_KINDS } from './model/types.ts'
import { compareKeys } from './model/ids.ts'

export type Records = {
  container: Container
  source: Source
  property: Definition
  view: View
  relation: RelationDefinition
  edge: RelationEdge
  template: TemplateRecord
  workflow: WorkflowRecord
  comment: CommentRecord
  principal: Principal
  grant: Grant
  event: EventRecord
  allocator: Allocator
}
export type AnyRecord = Records[RecordKind]

/** Pages live in the app's Repo; the engine only sees this narrow view of them. */
export interface PageStore {
  get(id: Id): PageLike | undefined
  all(): PageLike[]
}

export class MemoryPages implements PageStore {
  map = new Map<Id, PageLike>()
  constructor(pages: PageLike[] = []) {
    pages.forEach((p) => this.map.set(p.id, p))
  }
  get = (id: Id) => this.map.get(id)
  all = () => [...this.map.values()]
  put(p: PageLike) {
    this.map.set(p.id, p)
  }
  delete(id: Id) {
    this.map.delete(id)
  }
}

export interface Row {
  page: PageLike
  ext: RowExtension
  sourceId: Id
}

export function emptyMaps(): { [K in RecordKind]: Map<Id, Records[K]> } {
  const m = {} as { [K in RecordKind]: Map<Id, Records[K]> }
  for (const k of RECORD_KINDS) (m as Record<string, Map<Id, unknown>>)[k] = new Map()
  return m
}

export class Snapshot {
  generation: number
  rowsBySource = new Map<Id, Row[]>()
  rowByPage = new Map<Id, Row>()
  propsBySource = new Map<Id, Definition[]>()
  /** relation definition id -> from page -> live edges, sorted */
  edgesFrom = new Map<Id, Map<Id, RelationEdge[]>>()
  edgesTo = new Map<Id, Map<Id, RelationEdge[]>>()
  relationByProperty = new Map<Id, RelationDefinition>()
  childrenOf = new Map<Id, Id[]>()
  viewsByContainer = new Map<Id, View[]>()
  constructor(generation: number) {
    this.generation = generation
  }
}

export class DbState {
  vaultId: Id
  maps = emptyMaps()
  pages: PageStore
  generation = 0
  private snap: Snapshot | null = null
  constructor(vaultId: Id, pages: PageStore) {
    this.vaultId = vaultId
    this.pages = pages
  }

  get<K extends RecordKind>(kind: K, id: Id): Records[K] | undefined {
    return this.maps[kind].get(id)
  }
  /** All records of a kind, including tombstones. */
  all<K extends RecordKind>(kind: K): Records[K][] {
    return [...this.maps[kind].values()]
  }
  /** Live (not tombstoned) records. */
  live<K extends RecordKind>(kind: K): Records[K][] {
    return this.all(kind).filter((r) => r.deletedAt === null)
  }
  put<K extends RecordKind>(kind: K, rec: Records[K]) {
    this.maps[kind].set(rec.id, rec)
    this.invalidate()
  }
  remove(kind: RecordKind, id: Id) {
    this.maps[kind].delete(id)
    this.invalidate()
  }
  invalidate() {
    this.generation++
    this.snap = null
  }

  snapshot(): Snapshot {
    if (this.snap && this.snap.generation === this.generation) return this.snap
    const s = new Snapshot(this.generation)
    // properties
    const props = this.live('property')
    for (const p of props) (s.propsBySource.get(p.sourceId) ?? s.propsBySource.set(p.sourceId, []).get(p.sourceId)!).push(p)
    for (const list of s.propsBySource.values()) list.sort((a, b) => compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id))
    // relations
    for (const r of this.live('relation')) {
      s.relationByProperty.set(r.propertyId, r)
      if (r.inversePropertyId) s.relationByProperty.set(r.inversePropertyId, r)
    }
    // rows
    const sources = this.maps.source
    for (const page of this.pages.all()) {
      const ext = page.database
      if (!ext || page.kind === 'folder') continue
      const src = sources.get(ext.sourceId)
      if (!src || src.deletedAt !== null) continue
      const row: Row = { page, ext, sourceId: ext.sourceId }
      s.rowByPage.set(page.id, row)
      if (page.deletedAt !== null) continue
      ;(s.rowsBySource.get(ext.sourceId) ?? s.rowsBySource.set(ext.sourceId, []).get(ext.sourceId)!).push(row)
      if (ext.parentItemId) (s.childrenOf.get(ext.parentItemId) ?? s.childrenOf.set(ext.parentItemId, []).get(ext.parentItemId)!).push(page.id)
    }
    for (const list of s.rowsBySource.values()) list.sort((a, b) => compareKeys(a.ext.sortKey, b.ext.sortKey) || compareKeys(a.page.id, b.page.id))
    // edges (live = not tombstoned); the inverse view is derived from the same canonical record
    const edges = this.live('edge').sort((a, b) => compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id))
    for (const e of edges) {
      const f = s.edgesFrom.get(e.definitionId) ?? s.edgesFrom.set(e.definitionId, new Map()).get(e.definitionId)!
      ;(f.get(e.fromPageId) ?? f.set(e.fromPageId, []).get(e.fromPageId)!).push(e)
      const t = s.edgesTo.get(e.definitionId) ?? s.edgesTo.set(e.definitionId, new Map()).get(e.definitionId)!
      ;(t.get(e.toPageId) ?? t.set(e.toPageId, []).get(e.toPageId)!).push(e)
    }
    // views
    for (const v of this.live('view')) (s.viewsByContainer.get(v.containerId) ?? s.viewsByContainer.set(v.containerId, []).get(v.containerId)!).push(v)
    for (const list of s.viewsByContainer.values()) list.sort((a, b) => compareKeys(a.sortKey, b.sortKey))
    this.snap = s
    return s
  }

  // convenient lookups used everywhere
  rows(sourceId: Id): Row[] {
    return this.snapshot().rowsBySource.get(sourceId) ?? []
  }
  row(pageId: Id): Row | undefined {
    return this.snapshot().rowByPage.get(pageId)
  }
  props(sourceId: Id): Definition[] {
    return this.snapshot().propsBySource.get(sourceId) ?? []
  }
  prop(propertyId: Id): Definition | undefined {
    const p = this.maps.property.get(propertyId)
    return p && p.deletedAt === null ? p : undefined
  }
  relationOf(propertyId: Id): RelationDefinition | undefined {
    return this.snapshot().relationByProperty.get(propertyId)
  }
  /** live outgoing edges of `pageId` for a relation definition, in order */
  edgesOut(defId: Id, pageId: Id): RelationEdge[] {
    return this.snapshot().edgesFrom.get(defId)?.get(pageId) ?? []
  }
  edgesIn(defId: Id, pageId: Id): RelationEdge[] {
    return this.snapshot().edgesTo.get(defId)?.get(pageId) ?? []
  }
  sourceOwner(source: Source): Container | undefined {
    return this.maps.container.get(source.ownerContainerId)
  }
  viewsOf(containerId: Id): View[] {
    return this.snapshot().viewsByContainer.get(containerId) ?? []
  }
}
