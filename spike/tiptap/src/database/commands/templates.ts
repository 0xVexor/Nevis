// Templates and repeats (handoff §18) and moving rows between sources (§13).
import type { Cell, Id, Json, TemplateRecord } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keyBetween } from '../model/ids.ts'
import { same } from '../model/json.ts'
import { defaultCell, validateCell } from '../props/registry.ts'
import { MAX_CATCH_UP_WITHOUT_PREVIEW, repeatOccurrences } from '../repeat.ts'
import { register, type Ctx } from './coordinator.ts'
import { createRow } from './rows.ts'
import { allocate, bumpSchema, lastKey, property, source } from './util.ts'

const MAX_NEST_DEPTH = 3

/** Replace `{{nested:N}}` placeholder page-link ids in a copied template body with the ids of rows created for this application. */
function remapBody(body: Json, ids: Id[]): Json {
  const text = JSON.stringify(body)
  return JSON.parse(text.replace(/\{\{nested:(\d+)\}\}/g, (_m, n) => ids[Number(n)] ?? '')) as Json
}

function createNested(cx: Ctx, t: TemplateRecord, depth: number): Id[] {
  if (depth >= MAX_NEST_DEPTH) fail('CYCLE', `templates nest at most ${MAX_NEST_DEPTH} levels deep`)
  return t.nested.map((n) => {
    const nt = cx.d.get('template', n.templateId)
    if (!nt || nt.deletedAt !== null || nt.sourceId !== n.sourceId) fail('NOT_FOUND', 'nested template not found', { templateId: n.templateId })
    const r = createRow(cx, { sourceId: n.sourceId, templateId: nt!.id })
    const created = cx.d.page(r.pageId)!
    if (nt!.nested.length) {
      const sub = createNested(cx, nt!, depth + 1)
      cx.d.mutPage(created.id).content = remapBody(created.content as Json, sub)
    }
    return r.pageId
  })
}

register('template.apply', (cx, p: { templateId: Id; pageId?: Id; createInSourceId?: Id; bodyMode?: 'append' | 'replace' | 'none'; valuePolicy?: 'fill_empty' | 'overwrite' | 'none' }) => {
  const t = cx.d.get('template', p.templateId)
  if (!t || t.deletedAt !== null) fail('NOT_FOUND', 'template not found')
  if (!p.pageId) {
    if (!p.createInSourceId) fail('INVALID_VALUE', 'give a page or a source to create in')
    const nested = createNested(cx, t!, 0)
    const r = createRow(cx, { sourceId: p.createInSourceId, templateId: t!.id })
    if (nested.length) cx.d.mutPage(r.pageId).content = remapBody(cx.d.page(r.pageId)!.content as Json, nested)
    return { pageId: r.pageId, nested }
  }
  // applying to an existing row: never overwrite silently — values only fill empty cells unless the caller says otherwise
  const row = cx.d.row(p.pageId)
  if (!row) fail('NOT_FOUND', 'row not found')
  cx.access.assertRow(cx.env.actorId, row!, 'edit_rows')
  if (row!.sourceId !== t!.sourceId) fail('SCHEMA_MISMATCH', 'the template belongs to another source')
  const page = cx.d.mutPage(p.pageId)
  const nested = createNested(cx, t!, 0)
  const mode = p.bodyMode ?? 'append'
  if (mode !== 'none' && t!.body) {
    const incoming = remapBody(t!.body, nested) as { content?: Json[] }
    const cur = (page.content as { content?: Json[] } | undefined)?.content ?? []
    page.content = mode === 'replace' ? incoming : ({ type: 'doc', content: [...cur, ...(incoming.content ?? [])] } as Json)
  }
  const policy = p.valuePolicy ?? 'fill_empty'
  if (policy !== 'none') {
    for (const [pid, raw] of Object.entries(t!.defaults)) {
      const def = cx.d.prop(pid)
      if (!def) continue
      const has = page.database!.cells[pid]
      const dflt = defaultCell(def)
      const isEmptyNow = !has || same(has.value, dflt)
      if (policy === 'fill_empty' && !isEmptyNow) continue
      cx.access.assertEditProperty(cx.env.actorId, def, row!)
      page.database!.cells[pid] = { value: validateCell(def, raw as unknown as Cell), stamp: cx.stamp() }
    }
  }
  return { pageId: p.pageId, nested }
})

register('template.set_default', (cx, p: { sourceId: Id; templateId: Id | null }) => {
  const s = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, s.id, 'edit_schema')
  if (p.templateId) {
    const t = cx.d.get('template', p.templateId)
    if (!t || t.sourceId !== s.id || t.deletedAt !== null) fail('NOT_FOUND', 'template not found for this source')
  }
  cx.d.mut('source', s.id).defaultTemplateId = p.templateId
})

/**
 * Generate due occurrences of repeating templates exactly once. `now` is injected. If more than 30 are missed, nothing is created
 * unless `approveMany` is set (the UI shows the preview first). Occurrence keys are stable, so a restart never duplicates.
 */
register('template.run_repeats', (cx, p: { now?: string; approveMany?: boolean; sourceId?: Id }) => {
  const nowMs = p.now ? Date.parse(p.now) : cx.now
  const out: { templateId: Id; created: number; pending: number }[] = []
  for (const t of cx.d.live('template')) {
    if (!t.repeat || (p.sourceId && t.sourceId !== p.sourceId)) continue
    const curId = `repcursor:${t.id}:${t.scheduleVersion}`
    const cursor = cx.d.get('event', curId)
    const after = cursor ? ((cursor.data as { lastMs: number }).lastMs ?? 0) : Date.parse(`${t.repeat.startDate}T00:00:00Z`) - 86400000
    const occ = repeatOccurrences(t.repeat, t.id, t.scheduleVersion, after, nowMs)
    if (!occ.length) { out.push({ templateId: t.id, created: 0, pending: 0 }); continue }
    if (occ.length > MAX_CATCH_UP_WITHOUT_PREVIEW && !p.approveMany) { out.push({ templateId: t.id, created: 0, pending: occ.length }); continue }
    let created = 0
    for (const o of occ) {
      const evId = `rep:${o.key}`
      if (cx.d.get('event', evId)) continue // already generated: idempotent
      const r = createRow(cx, { sourceId: t.sourceId, templateId: t.id })
      cx.d.add('event', { ...cx.meta(evId), type: 'workflow_run', pageId: r.pageId, principalId: cx.env.actorId, data: { templateId: t.id, scheduledMs: o.scheduledMs, key: o.key, adjusted: o.adjusted } as Json })
      created++
    }
    const lastMs = occ[occ.length - 1].scheduledMs
    if (cursor) cx.d.mut('event', curId).data = { lastMs } as Json
    else cx.d.add('event', { ...cx.meta(curId), type: 'audit', pageId: null, principalId: null, data: { lastMs } as Json })
    out.push({ templateId: t.id, created, pending: 0 })
  }
  return out as unknown as Json
})

// ───── moving rows between sources ─────

export type MovePlan = {
  pageIds: Id[]
  destinationSourceId: Id
  /** source property id -> destination property id (same kind); everything unmapped is archived on the row */
  mapping: Record<Id, Id>
  optionMap?: Record<Id, Id>
  edgePolicy?: 'reject' | 'archive_invalid'
  includeDescendants?: boolean
}

export function planMove(cx: Pick<Ctx, 'd'>, p: MovePlan) {
  const dest = cx.d.get('source', p.destinationSourceId)
  const ids = new Set(p.pageIds)
  if (p.includeDescendants !== false) {
    for (let grew = true; grew; ) {
      grew = false
      for (const pg of cx.d.allPages()) if (pg.database?.parentItemId && ids.has(pg.database.parentItemId) && !ids.has(pg.id)) (ids.add(pg.id), (grew = true))
    }
  }
  const invalidEdges = cx.d.live('edge').filter((e) => {
    const rel = cx.d.get('relation', e.definitionId)
    if (!rel || rel.deletedAt !== null) return false
    const fromMoves = ids.has(e.fromPageId)
    const toMoves = ids.has(e.toPageId)
    return (fromMoves && rel.sourceId !== p.destinationSourceId) || (toMoves && rel.targetSourceId !== p.destinationSourceId)
  })
  return { dest, ids: [...ids], invalidEdges }
}

register('row.move', (cx, p: MovePlan) => {
  const plan = planMove(cx, p)
  if (!plan.dest || plan.dest.deletedAt !== null) fail('NOT_FOUND', 'destination source not found')
  const dest = plan.dest
  cx.access.assertSource(cx.env.actorId, dest.id, 'create')
  if (plan.invalidEdges.length && (p.edgePolicy ?? 'reject') === 'reject')
    fail('SCHEMA_MISMATCH', `${plan.invalidEdges.length} link(s) would become invalid; review them and choose archive_invalid`, { edgeIds: plan.invalidEdges.map((e) => e.id) })
  // mapping validity: same kind, destination property belongs to the destination source
  for (const [from, to] of Object.entries(p.mapping)) {
    const a = property(cx, from)
    const b = property(cx, to)
    if (b.sourceId !== dest.id) fail('SCHEMA_MISMATCH', 'mapped property is not in the destination source', { propertyId: to })
    if (a.kind !== b.kind) fail('SCHEMA_MISMATCH', `cannot map ${a.kind} to ${b.kind}; convert the property first`, { propertyId: from })
  }
  let key = lastKey(cx.d.rowsOf(dest.id).map((r) => ({ sortKey: r.ext.sortKey })))
  const moving = new Set(plan.ids)
  for (const id of plan.ids) {
    const r = cx.d.row(id)
    if (!r) fail('NOT_FOUND', 'row not found', { pageId: id })
    cx.access.assertRow(cx.env.actorId, r!, 'edit_rows')
    const page = cx.d.mutPage(id)
    const ext = page.database!
    const old = ext.cells
    const archive: Record<string, Json> = {}
    const next: typeof old = {}
    for (const [pid, c] of Object.entries(old)) {
      const to = p.mapping[pid]
      if (!to) { archive[pid] = c as unknown as Json; continue }
      const dd = cx.d.prop(to)!
      let value = c.value
      if (value.kind === 'select' || value.kind === 'status') { const m = p.optionMap?.[value.optionId ?? ''] ?? value.optionId; value = { ...value, optionId: m } as Cell }
      else if (value.kind === 'multi_select') value = { kind: 'multi_select', optionIds: value.optionIds.map((o) => p.optionMap?.[o] ?? o) }
      try {
        next[to] = { value: validateCell(dd, value), stamp: cx.stamp() }
      } catch {
        archive[pid] = c as unknown as Json // an option that does not exist in the destination is archived, never silently invented
      }
    }
    // unique ids: the old token is archived, the destination gets its own allocation
    for (const [pid, tok] of Object.entries(ext.allocatedIds)) archive[`alloc:${pid}`] = tok
    ext.allocatedIds = {}
    for (const d of cx.d.props(dest.id)) if (d.kind === 'unique_id') ext.allocatedIds[d.id] = allocate(cx, d, 1)[0]
    if (Object.keys(archive).length) (ext.archivedCells as Record<string, Json>)[`move@${ext.sourceId}@${cx.env.operationId}`] = archive as Json
    ext.cells = next
    ext.sourceId = dest.id
    ext.schemaRevision = dest.schemaRevision
    if (!ext.parentItemId || !moving.has(ext.parentItemId)) ext.parentItemId = null
    key = keyBetween(key, null)
    ext.sortKey = key
    page.parentId = page.parentId // Explorer position is preserved
  }
  for (const e of plan.invalidEdges) cx.d.mut('edge', e.id).deletedAt = cx.now // archived (tombstone) so history can restore them
  bumpSchema(cx, dest.id)
  return { moved: plan.ids.length, archivedEdges: plan.invalidEdges.length }
})

