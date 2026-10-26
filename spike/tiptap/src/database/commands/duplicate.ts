// Duplicating a whole database (handoff §13): every owned record gets a new id and internal references are remapped; relations to
// sources that are NOT duplicated become one-way (the other side is not touched); linked sources stay links unless the user asks
// for an independent copy; a schema-only copy has no rows and no allocated ids.
import type { Definition, Id, Json, PageLike, RelationDefinition } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { remapIds } from '../backup2.ts'
import { register } from './coordinator.ts'
import { EMPTY_DOC, container, ensureOwner } from './util.ts'

register('database.duplicate', (cx, p: { containerId: Id; withRows: boolean; independentLinked?: boolean; title?: string }) => {
  ensureOwner(cx)
  const src = container(cx, p.containerId)
  const host = cx.d.page(src.hostPageId)
  if (!host) fail('NOT_FOUND', 'host page not found')
  const owned = cx.d.live('source').filter((s) => s.ownerContainerId === src.id)
  const linkedOnly = src.sourceLinks.map((l) => l.sourceId).filter((id) => !owned.some((s) => s.id === id))
  const copySources = [...owned, ...(p.independentLinked ? linkedOnly.map((id) => cx.d.get('source', id)!).filter(Boolean) : [])]
  for (const s of copySources) cx.access.assertSource(cx.env.actorId, s.id, 'read')
  const map = new Map<Id, Id>()
  const fresh = (id: Id) => { const n = cx.ids(); map.set(id, n); return n }
  const newContainerId = fresh(src.id)
  for (const s of copySources) fresh(s.id)
  const props = cx.d.live('property').filter((d) => copySources.some((s) => s.id === d.sourceId))
  for (const d of props) fresh(d.id)
  const views = cx.d.live('view').filter((v) => v.containerId === src.id)
  for (const v of views) fresh(v.id)
  const templates = cx.d.live('template').filter((tp) => copySources.some((s) => s.id === tp.sourceId))
  for (const tp of templates) fresh(tp.id)
  const workflows = cx.d.live('workflow').filter((w) => copySources.some((s) => s.id === w.sourceId))
  for (const w of workflows) fresh(w.id)
  const relations = cx.d.live('relation').filter((r) => copySources.some((s) => s.id === r.sourceId))
  for (const r of relations) fresh(r.id)

  // host page: a new page next to the original
  const hostCopy: PageLike = { ...host!, id: cx.ids(), title: p.title ?? `${host!.title} (copy)`, favorite: false, content: host!.content ?? EMPTY_DOC, updatedAt: cx.now, deletedAt: null }
  delete (hostCopy as { database?: unknown }).database
  delete (hostCopy as { recordMeta?: unknown }).recordMeta
  cx.d.addPage(hostCopy)
  map.set(src.hostPageId, hostCopy.id)

  const rowIds = new Map<Id, Id>()
  if (p.withRows) for (const s of copySources) for (const r of cx.d.rowsOf(s.id)) rowIds.set(r.page.id, cx.ids())
  // maps used for deep id replacement: everything copied, plus the new rows
  const all = new Map<Id, Id>([...map, ...rowIds])

  const clone = <T extends Record<string, unknown>>(rec: T): T => remapIds(structuredClone(rec), all)
  cx.d.add('container', { ...(clone(src as never) as typeof src), ...cx.meta(newContainerId), hostPageId: hostCopy.id, title: hostCopy.title, sourceLinks: src.sourceLinks.map((l) => ({ sourceId: all.get(l.sourceId) ?? l.sourceId, sortKey: l.sortKey })) })
  for (const s of copySources) {
    const n = clone(s as never) as typeof s
    cx.d.add('source', { ...n, ...cx.meta(all.get(s.id)!), ownerContainerId: newContainerId, schemaRevision: 1, name: s.ownerContainerId === src.id ? s.name : s.name })
  }
  for (const d of props) {
    const n = clone(d as never) as Definition
    // option ids stay (they are scoped to their property); relation properties are rebuilt below
    cx.d.add('property', { ...n, ...cx.meta(all.get(d.id)!), sourceId: all.get(d.sourceId)! })
  }
  const copied = new Set(copySources.map((s) => s.id))
  for (const r of relations) {
    const n = clone(r as never) as RelationDefinition
    const targetCopied = copied.has(r.targetSourceId)
    const invDefId = r.inversePropertyId
    const rec: RelationDefinition = { ...n, ...cx.meta(all.get(r.id)!), sourceId: all.get(r.sourceId)!, propertyId: all.get(r.propertyId)!, targetSourceId: targetCopied ? all.get(r.targetSourceId)! : r.targetSourceId }
    if (!targetCopied) {
      // a paired relation to a source that is not copied becomes one-way: the other source never learns about the copy
      rec.mode = r.mode === 'self_symmetric' ? 'one_way' : r.mode === 'paired' ? 'one_way' : r.mode
      rec.inversePropertyId = null
    } else if (invDefId) rec.inversePropertyId = all.get(invDefId) ?? null
    cx.d.add('relation', rec)
    if (!targetCopied && invDefId && cx.d.get('property', all.get(invDefId) ?? '')) cx.d.mut('property', all.get(invDefId)!).deletedAt = cx.now
  }
  // inverse properties of relations whose forward side is in a source we copied but whose own source is not copied are skipped (not in `props`)
  for (const v of views) {
    const n = clone(v as never) as typeof v
    cx.d.add('view', { ...n, ...cx.meta(all.get(v.id)!), containerId: newContainerId, sourceId: v.sourceId ? (all.get(v.sourceId) ?? v.sourceId) : null, parentDashboardId: v.parentDashboardId ? (all.get(v.parentDashboardId) ?? null) : null })
  }
  for (const tp of templates) cx.d.add('template', { ...(clone(tp as never) as typeof tp), ...cx.meta(all.get(tp.id)!), sourceId: all.get(tp.sourceId)! })
  for (const w of workflows) cx.d.add('workflow', { ...(clone(w as never) as typeof w), ...cx.meta(all.get(w.id)!), sourceId: all.get(w.sourceId)!, definitionRevision: 1 })

  if (p.withRows) {
    for (const [oldId, newId] of rowIds) {
      const r = cx.d.row(oldId)!
      const ext = clone(r.page.database as never) as NonNullable<PageLike['database']>
      ext.revision = 0
      ext.sourceId = all.get(r.sourceId)!
      ext.parentItemId = r.page.database!.parentItemId ? (rowIds.get(r.page.database!.parentItemId) ?? null) : null
      for (const c of Object.values(ext.cells)) c.stamp = cx.stamp()
      ext.allocatedIds = {} // new tokens are allocated on demand; copies never share numbers
      const copy: PageLike = { ...r.page, id: newId, parentId: hostCopy.id, database: ext, deletedAt: null }
      delete (copy as { recordMeta?: unknown }).recordMeta
      cx.d.addPage(copy)
    }
    // canonical edges between copied rows are copied; edges to rows outside the copy are dropped (the original links stay with the original)
    for (const e of cx.d.live('edge')) {
      const nf = rowIds.get(e.fromPageId)
      const nt = rowIds.get(e.toPageId)
      const nd = all.get(e.definitionId)
      if (nf && nt && nd) cx.d.add('edge', { ...cx.meta(), definitionId: nd, fromPageId: nf, toPageId: nt, sortKey: e.sortKey, stamp: cx.stamp() })
    }
  }
  return { containerId: newContainerId, hostPageId: hostCopy.id, mapping: Object.fromEntries(map) as unknown as Json }
})
