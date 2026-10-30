// Row commands (handoff §11, §12.1): a database row is an existing Page with an optional `database` extension.
import type { Cell, Definition, Filter, Id, Json, PageLike, RowExtension } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keyBetween } from '../model/ids.ts'
import { hash, same } from '../model/json.ts'
import { DESCRIPTORS, defaultCell, validateCell } from '../props/registry.ts'
import { cfgOf } from '../props/config.ts'
import { Draft } from './draft.ts'
import { register, readPath, writePath, type Ctx } from './coordinator.ts'
import { assertNotImported } from './external.ts'
import { EMPTY_DOC, LIMITS, allocate, lastKey, property, source, view } from './util.ts'
import type { UndoItem } from '../storage/types.ts'
import type { Row } from '../state.ts'
import { identifyBlocks, identityVersion, BLOCK_IDENTITY_VERSION } from '../../documents/blockIdentity.ts'

// ───── value precedence on creation (§11) ─────

export type Inferred = { cells: Record<Id, Cell>; warnings: { code: string; detail: string }[] }

/** Only positive exact-equality predicates of an AND tree that uniquely determine a writable scalar, or one explicit contains. */
export function inferFromFilter(d: Pick<Draft, 'prop'>, filter: Filter | null): Inferred {
  const cells: Record<Id, Cell> = {}
  const warnings: Inferred['warnings'] = []
  const conflicted = new Set<Id>()
  const preds: Extract<Filter, { kind: 'predicate' }>[] = []
  const collect = (f: Filter) => {
    if (f.kind === 'predicate') preds.push(f)
    else if (f.kind === 'and') f.children.forEach(collect) // OR (and anything under it) never infers
  }
  if (filter) collect(filter)
  for (const p of preds) {
    const def = d.prop(p.propertyId)
    if (!def || !DESCRIPTORS[def.kind].writable || def.kind === 'title') continue
    let cell: Cell | null = null
    if (p.op === 'equals') {
      if ((def.kind === 'select' || def.kind === 'status') && typeof p.operand === 'string') cell = { kind: def.kind, optionId: p.operand }
      else if (def.kind === 'checkbox' && typeof p.operand === 'boolean') cell = { kind: 'checkbox', value: p.operand }
      else if (def.kind === 'number' && typeof p.operand === 'number') cell = { kind: 'number', value: p.operand }
      else if ((def.kind === 'url' || def.kind === 'email' || def.kind === 'phone') && typeof p.operand === 'string') cell = { kind: def.kind, value: p.operand }
      else if (def.kind === 'text' && typeof p.operand === 'string') cell = { kind: 'text', runs: [{ text: p.operand }] }
    } else if (p.op === 'contains' && typeof p.operand === 'string') {
      if (def.kind === 'multi_select') cell = { kind: 'multi_select', optionIds: [p.operand] }
      else if (def.kind === 'people') cell = { kind: 'people', principalIds: [p.operand] }
    }
    if (!cell) continue
    if (conflicted.has(def.id)) continue
    if (cells[def.id] && !same(cells[def.id], cell)) {
      delete cells[def.id]
      conflicted.add(def.id)
      warnings.push({ code: 'INFER_CONFLICT', detail: def.name })
      continue
    }
    cells[def.id] = cell
  }
  return { cells, warnings }
}

function setCell(cx: Ctx, page: PageLike, def: Definition, cell: Cell | null, row?: Row) {
  const ext = page.database!
  assertNotImported(cx, ext.sourceId, def.id)
  if (!DESCRIPTORS[def.kind].writable || def.kind === 'title') fail('INVALID_VALUE', `${def.name} cannot be edited directly`, { propertyId: def.id })
  if (def.sourceId !== ext.sourceId) fail('SCHEMA_MISMATCH', 'property belongs to another source', { propertyId: def.id })
  cx.access.assertEditProperty(cx.env.actorId, def, row ?? { page, ext, sourceId: ext.sourceId })
  if (cell === null) {
    delete ext.cells[def.id]
    return
  }
  const v = validateCell(def, cell)
  const prev = ext.cells[def.id]?.value ?? defaultCell(def)
  if (same(prev, v) && ext.cells[def.id]) return
  if (same(prev, v) && !ext.cells[def.id] && same(v, defaultCell(def))) return // writing the default again changes nothing
  ext.cells[def.id] = { value: v, stamp: cx.stamp() }
}

function rowBytesCheck(page: PageLike) {
  const n = JSON.stringify(page.database).length
  if (n > LIMITS.rowBytes) fail('QUOTA', `row properties exceed ${LIMITS.rowBytes} bytes`, { size: n, limit: LIMITS.rowBytes })
}

export function newExt(cx: Ctx, sourceId: Id, sortKey: string, parentItemId: Id | null): RowExtension {
  return { format: 1, sourceId, schemaRevision: source(cx, sourceId).schemaRevision, revision: 0, sortKey, parentItemId, cells: {}, allocatedIds: {}, archivedCells: {} }
}

function assertNoParentCycle(d: Draft, pageId: Id, parentId: Id | null, sourceId: Id) {
  if (parentId === null) return
  if (parentId === pageId) fail('CYCLE', 'a sub-item cannot be its own parent')
  const seen = new Set<Id>()
  for (let p: Id | null = parentId; p; ) {
    if (p === pageId || seen.has(p)) fail('CYCLE', 'a sub-item cannot be nested under its own descendant')
    seen.add(p)
    const r = d.row(p)
    if (!r) fail('NOT_FOUND', 'parent item not found', { pageId: p })
    if (r!.sourceId !== sourceId) fail('SCHEMA_MISMATCH', 'a parent item must be in the same source')
    p = r!.ext.parentItemId
  }
}

type RowCreate = {
  id?: Id
  sourceId: Id
  title?: string
  explicitValues?: Record<Id, Cell>
  /** location-implied values (calendar day, board column) */
  context?: { propertyId: Id; cell: Cell }[]
  templateId?: Id
  viewId?: Id
  parentItemId?: Id | null
  beforePageId?: Id | null
}

export function createRow(cx: Ctx, p: RowCreate): { pageId: Id; warnings: Json } {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'create')
  const stats = cx.d.rowStats(src.id)
  if (stats.count >= LIMITS.rowsPerSource) fail('QUOTA', `a source can hold at most ${LIMITS.rowsPerSource} rows`)
  const owner = cx.d.get('container', src.ownerContainerId)
  const v = p.viewId ? view(cx, p.viewId) : null
  const tid = p.templateId ?? v?.defaultTemplateId ?? src.defaultTemplateId
  const tpl = tid ? cx.d.get('template', tid) : undefined
  if (tid && (!tpl || tpl.deletedAt !== null || tpl.sourceId !== src.id)) fail('NOT_FOUND', 'template not found for this source', { templateId: tid })
  const inferred = inferFromFilter(cx.d, v?.filter ?? null)
  inferred.warnings.forEach((w) => cx.warnings.push(w))

  const id = p.id ?? cx.ids()
  let sortKey: string
  if (p.beforePageId) {
    const rows = cx.d.rowsOf(src.id)
    const i = rows.findIndex((r) => r.page.id === p.beforePageId)
    sortKey = keyBetween(i > 0 ? rows[i - 1].ext.sortKey : null, i >= 0 ? rows[i].ext.sortKey : null)
  } else sortKey = keyBetween(stats.last, null)
  if (p.parentItemId) assertNoParentCycle(cx.d, id, p.parentItemId, src.id)

  const page: PageLike = {
    id, parentId: owner?.hostPageId ?? null, title: p.title ?? (tpl ? '' : ''), favorite: false, sort: stats.count,
    content: identifyBlocks(tpl?.body ?? EMPTY_DOC, cx.ids).content, updatedAt: cx.now, deletedAt: null,
  } as PageLike
  if (tpl?.icon) page.icon = tpl.icon
  if (tpl?.cover && typeof tpl.cover === 'object') page.cover = tpl.cover
  page.database = newExt(cx, src.id, sortKey, p.parentItemId ?? null)
  cx.d.addPage(page)

  const apply = (propId: Id, cell: Cell) => {
    const def = cx.d.prop(propId)
    if (!def) return // a template / filter may refer to a deleted property: ignore it
    setCell(cx, page, def, cell)
  }
  for (const [pid, c] of Object.entries(inferred.cells)) apply(pid, c) // 4. safe inference
  if (tpl) for (const [pid, c] of Object.entries(tpl.defaults)) apply(pid, c as unknown as Cell) // 3. template (view default over source default)
  for (const c of p.context ?? []) apply(c.propertyId, c.cell) // 2. explicit creation location
  for (const [pid, c] of Object.entries(p.explicitValues ?? {})) { // 1. explicit values
    const def = property(cx, pid)
    setCell(cx, page, def, c)
  }
  // unique ids: one allocation per unique_id property
  for (const def of cx.d.props(src.id)) if (def.kind === 'unique_id') page.database!.allocatedIds[def.id] = allocate(cx, def, 1)[0]
  rowBytesCheck(page)
  return { pageId: id, warnings: inferred.warnings as unknown as Json }
}

register('row.create', (cx, p: RowCreate) => createRow(cx, p) as unknown as Json)

register('row.attach', (cx, p: { sourceId: Id; pageId: Id; mapping?: { tagsTo?: Id; statusTo?: Id; createOptions?: boolean } }) => {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_rows')
  const page0 = cx.d.page(p.pageId)
  if (!page0 || page0.deletedAt !== null) fail('NOT_FOUND', 'page not found', { pageId: p.pageId })
  if (page0!.kind === 'folder') fail('INVALID_VALUE', 'a folder cannot become a database row')
  if (page0!.database) fail('INVALID_VALUE', 'this page already belongs to a source', { sourceId: page0!.database.sourceId })
  const rows = cx.d.rowsOf(src.id)
  const page = cx.d.mutPage(p.pageId) // Page.parentId is untouched: membership never reparents silently
  page.database = newExt(cx, src.id, lastKey(rows.map((r) => ({ sortKey: r.ext.sortKey }))), null)
  const legacy = page as PageLike & { tags?: string[]; status?: string }
  const m = p.mapping
  if (m?.tagsTo && legacy.tags?.length) {
    const def = property(cx, m.tagsTo)
    const names = legacy.tags
    const ids = names.map((n) => optionByName(cx, def, n, !!m.createOptions)).filter((x): x is Id => x !== null)
    setCell(cx, page, def, def.kind === 'multi_select' ? { kind: 'multi_select', optionIds: ids } : { kind: 'select', optionId: ids[0] ?? null })
  }
  if (m?.statusTo && legacy.status) {
    const def = property(cx, m.statusTo)
    const label = legacy.status === 'todo' ? 'To-do' : legacy.status === 'doing' ? 'In progress' : 'Done'
    const id = optionByName(cx, def, label, false)
    setCell(cx, page, def, { kind: def.kind === 'status' ? 'status' : 'select', optionId: id } as Cell)
  }
  for (const def of cx.d.props(src.id)) if (def.kind === 'unique_id') page.database!.allocatedIds[def.id] = allocate(cx, def, 1)[0]
  return { pageId: p.pageId }
})

function optionByName(cx: Ctx, def: Definition, name: string, create: boolean): Id | null {
  const opts = (def.config as unknown as { options: { id: Id; name: string; sortKey: string }[] }).options
  const k = name.normalize('NFC').trim().toLowerCase()
  const hits = opts.filter((o) => o.name.normalize('NFC').trim().toLowerCase() === k)
  if (hits.length > 1) fail('INVALID_VALUE', `ambiguous option label ${name}`)
  if (hits[0]) return hits[0].id
  if (!create) return null // never invent options silently
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  const m = cx.d.mut('property', def.id)
  const mo = (m.config as unknown as { options: { id: Id; name: string; color: string; sortKey: string }[] }).options
  const id = cx.ids()
  mo.push({ id, name, color: 'default', sortKey: lastKey(mo) })
  return id
}

type RowPatch = { pageId: Id; title?: string; cellChanges?: Record<Id, Cell | null>; parentItemId?: Id | null }

register('row.patch', (cx, p: RowPatch) => {
  const base = cx.d.row(p.pageId)
  if (!base) fail('NOT_FOUND', 'row not found', { pageId: p.pageId })
  cx.access.assertRow(cx.env.actorId, base!, 'edit_rows')
  const page = cx.d.mutPage(p.pageId)
  const row: Row = { page, ext: page.database!, sourceId: page.database!.sourceId }
  if (p.title !== undefined) {
    if (typeof p.title !== 'string' || p.title.length > 1024 * 1024) fail('INVALID_VALUE', 'title must be text up to 1 MiB')
    assertNotImported(cx, row.sourceId, '$title')
    const t = cx.d.get('property', cx.d.get('source', row.sourceId)!.titlePropertyId)
    if (t) cx.access.assertEditProperty(cx.env.actorId, t, row)
    page.title = p.title
  }
  for (const [pid, cell] of Object.entries(p.cellChanges ?? {})) {
    const def = property(cx, pid)
    setCell(cx, page, def, cell, row)
  }
  if (p.parentItemId !== undefined) {
    assertNoParentCycle(cx.d, page.id, p.parentItemId, row.sourceId)
    page.database!.parentItemId = p.parentItemId
  }
  rowBytesCheck(page)
})

register('row.patch_bulk', (cx, p: { patches: RowPatch[] }) => {
  // atomic: the first invalid cell aborts the whole batch before anything is written
  for (const one of p.patches) {
    const h = cx.d.row(one.pageId)
    if (!h) fail('NOT_FOUND', 'row not found', { pageId: one.pageId })
    cx.access.assertRow(cx.env.actorId, h!, 'edit_rows')
    const page = cx.d.mutPage(one.pageId)
    const row: Row = { page, ext: page.database!, sourceId: page.database!.sourceId }
    if (one.title !== undefined) page.title = one.title
    for (const [pid, cell] of Object.entries(one.cellChanges ?? {})) setCell(cx, page, property(cx, pid), cell, row)
    if (one.parentItemId !== undefined) {
      assertNoParentCycle(cx.d, page.id, one.parentItemId, row.sourceId)
      page.database!.parentItemId = one.parentItemId
    }
    rowBytesCheck(page)
  }
  return { count: p.patches.length }
})

register('page.patch_body', (cx, p: { pageId: Id; content: Json; contentSchema?: string }) => {
  const base = cx.d.page(p.pageId)
  if (!base || base.deletedAt !== null) fail('NOT_FOUND', 'page not found', { pageId: p.pageId })
  if (identityVersion(base!.content) > BLOCK_IDENTITY_VERSION) fail('SCHEMA_MISMATCH', 'Unsupported block identity version')
  if (base!.database) {
    const r = cx.d.row(p.pageId)
    if (r) cx.access.assertRow(cx.env.actorId, r, 'edit_rows')
  }
  const page = cx.d.mutPage(p.pageId) // the database extension rides along untouched
  page.content = identifyBlocks(p.content).content
})

register('row.reorder', (cx, p: { pageId: Id; beforePageId: Id | null }) => {
  const r = cx.d.row(p.pageId)
  if (!r) fail('NOT_FOUND', 'row not found')
  cx.access.assertRow(cx.env.actorId, r!, 'edit_rows')
  const rows = cx.d.rowsOf(r!.sourceId).filter((x) => x.page.id !== p.pageId)
  const i = p.beforePageId ? rows.findIndex((x) => x.page.id === p.beforePageId) : rows.length
  if (i < 0) fail('NOT_FOUND', 'reference row not found')
  cx.d.mutPage(p.pageId).database!.sortKey = keyBetween(i > 0 ? rows[i - 1].ext.sortKey : null, i < rows.length ? rows[i].ext.sortKey : null)
})

// ───── trash / restore / purge ─────

function withDescendants(d: Draft, ids: Id[], include: boolean): Id[] {
  const out = new Set(ids)
  if (include) {
    const all = d.allPages().filter((p) => p.database?.parentItemId)
    for (let grew = true; grew; ) {
      grew = false
      for (const p of all) if (!out.has(p.id) && out.has(p.database!.parentItemId!)) (out.add(p.id), (grew = true))
    }
  }
  return [...out]
}

register('row.trash', (cx, p: { pageIds: Id[]; includeDescendants?: boolean }) => {
  const ids = withDescendants(cx.d, p.pageIds, p.includeDescendants !== false)
  for (const id of ids) {
    const r = cx.d.row(id)
    if (!r) fail('NOT_FOUND', 'row not found', { pageId: id })
    cx.access.assertRow(cx.env.actorId, r!, 'edit_rows')
    if (r!.page.deletedAt === null) cx.d.mutPage(id).deletedAt = cx.now
  }
  return { count: ids.length }
})

register('row.restore', (cx, p: { pageIds: Id[]; includeDescendants?: boolean }) => {
  const ids = new Set(p.pageIds)
  if (p.includeDescendants !== false) {
    for (const root of p.pageIds) {
      const t = cx.d.page(root)?.deletedAt
      for (const x of cx.d.allPages()) if (x.database?.parentItemId && t && x.deletedAt === t) ids.add(x.id)
    }
  }
  for (const id of ids) {
    const pg = cx.d.page(id)
    if (!pg?.database) fail('NOT_FOUND', 'row not found', { pageId: id })
    cx.access.assertRow(cx.env.actorId, { page: pg!, ext: pg!.database!, sourceId: pg!.database!.sourceId }, 'edit_rows')
    if (pg!.deletedAt !== null) cx.d.mutPage(id).deletedAt = null // edges kept their tombstone state; eligible links simply become live again
  }
  return { count: ids.size }
})

export const purgeToken = (ids: Id[]) => hash([...ids].sort())

register('row.purge', (cx, p: { pageIds: Id[]; includeDescendants?: boolean; previewToken: string }) => {
  const ids = withDescendants(cx.d, p.pageIds, p.includeDescendants !== false)
  if (p.previewToken !== purgeToken(ids)) fail('INVALID_VALUE', 'purge needs the token from a fresh preview')
  const gone = new Set(ids)
  for (const id of ids) {
    const r = cx.d.row(id) ?? (cx.d.page(id)?.database ? { page: cx.d.page(id)!, ext: cx.d.page(id)!.database!, sourceId: cx.d.page(id)!.database!.sourceId } : undefined)
    if (!r) fail('NOT_FOUND', 'row not found', { pageId: id })
    cx.access.assertRow(cx.env.actorId, r!, 'manage')
    cx.d.removePage(id)
  }
  for (const e of cx.d.live('edge')) if (gone.has(e.fromPageId) || gone.has(e.toPageId)) cx.d.mut('edge', e.id).deletedAt = cx.now // tombstones, not removal
  return { count: ids.length }
})

// ───── duplicate ─────

register('row.duplicate', (cx, p: { rootPageIds: Id[]; includeDescendants?: boolean; retainExternalRelations?: boolean }) => {
  const idMap = new Map<Id, Id>()
  const order = withDescendants(cx.d, p.rootPageIds, p.includeDescendants !== false)
  for (const id of order) idMap.set(id, cx.ids())
  for (const id of order) {
    const r = cx.d.row(id)
    if (!r) fail('NOT_FOUND', 'row not found', { pageId: id })
    cx.access.assertRow(cx.env.actorId, r!, 'edit_rows')
    const src = r!.page
    const ext = structuredClone(r!.ext) as RowExtension
    ext.revision = 0
    ext.sortKey = keyBetween(r!.ext.sortKey, null)
    ext.parentItemId = r!.ext.parentItemId && idMap.has(r!.ext.parentItemId) ? idMap.get(r!.ext.parentItemId)! : r!.ext.parentItemId
    for (const c of Object.values(ext.cells)) c.stamp = cx.stamp()
    ext.allocatedIds = {}
    const copy: PageLike = { ...src, id: idMap.get(id)!, content: identifyBlocks(src.content, cx.ids).content, database: ext, deletedAt: null, favorite: false } as PageLike
    delete (copy as { recordMeta?: unknown }).recordMeta
    cx.d.addPage(copy)
    for (const def of cx.d.props(r!.sourceId)) if (def.kind === 'unique_id') ext.allocatedIds[def.id] = allocate(cx, def, 1)[0]
  }
  if (p.retainExternalRelations !== false) {
    for (const e of cx.d.live('edge')) {
      const rel = cx.d.get('relation', e.definitionId)
      if (!rel || rel.deletedAt !== null) continue
      const fromIn = idMap.has(e.fromPageId)
      const toIn = idMap.has(e.toPageId)
      if (!fromIn && !toIn) continue
      if (!fromIn && rel.inverseCardinality === 'one') { cx.warnings.push({ code: 'EDGE_SKIPPED', detail: e.id }); continue }
      const ne = { ...cx.meta(), definitionId: e.definitionId, fromPageId: idMap.get(e.fromPageId) ?? e.fromPageId, toPageId: idMap.get(e.toPageId) ?? e.toPageId, sortKey: e.sortKey, stamp: cx.stamp() }
      cx.d.add('edge', ne)
    }
  }
  return { mapping: Object.fromEntries(idMap) }
})

// ───── undo ─────

register('undo.apply', (cx, p: { group: { items: UndoItem[] }; skip?: { id: Id; path: string }[] }) => {
  const skip = new Set((p.skip ?? []).map((s) => `${s.id}|${s.path}`))
  for (const it of p.group.items) {
    if (it.t === 'record') {
      if (skip.has(`${it.id}|${it.kind}`)) continue
      const cur = cx.d.get(it.kind, it.id)
      if (!cur) continue
      const m = cx.d.mut(it.kind, it.id) as unknown as Record<string, unknown>
      if (it.before === null) m.deletedAt = cx.now // creation undone = tombstone (history keeps it)
      else {
        const keep = ['revision', 'updatedAt', 'updatedBy', 'lastOperationId', 'createdAt', 'createdBy']
        for (const [k, v] of Object.entries(it.before)) if (!keep.includes(k)) m[k] = structuredClone(v)
      }
    } else {
      const pg = cx.d.page(it.id)
      if (!pg) continue
      const m = cx.d.mutPage(it.id)
      if (it.created) { m.deletedAt = cx.now; continue }
      for (const path of it.paths) {
        if (skip.has(`${it.id}|${path.path}`)) continue
        if (!same(readPath(m, path.path), path.after)) continue
        writePath(m, path.path, path.before, cx.stamp())
      }
    }
  }
})

export { cfgOf }
