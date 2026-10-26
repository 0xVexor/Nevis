// View behaviour that is not rendering: what a drag means, which items a calendar / timeline / map shows, how a dashboard combines
// filters. Pure and tested; the React views only draw what this returns and dispatch the commands it plans.
import type { Cell, DateValue, Filter, Id, Json } from './model/types.ts'
import { addDays, civilOf, dateInterval, moveEndpoint, shiftDays, startOfDayMs } from './dates.ts'
import { statusConfig } from './props/config.ts'
import { NONE_GROUP } from './query/engine.ts'
import { Resolver } from './resolver.ts'
import type { DbState } from './state.ts'

export type PlannedCommand = { type: string; payload: Json }
export type Plan = { ok: true; noop?: boolean; confirm?: 'clear_multiple'; commands: PlannedCommand[] } | { ok: false; reason: string }

const COMPUTED = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'button', 'connected']

export type BoardDrop = {
  pageId: Id
  groupPropertyId: Id
  fromKey: string
  toKey: string
  /** an active sort decides order: manual reordering is not allowed without removing the sort */
  sortsActive?: boolean
  reorderWithinGroup?: boolean
  mode?: 'option' | 'status_group'
}

export function planBoardDrop(state: DbState, d: BoardDrop): Plan {
  const def = state.prop(d.groupPropertyId)
  const row = state.row(d.pageId)
  if (!def || !row) return { ok: false, reason: 'not found' }
  if (COMPUTED.includes(def.kind)) return { ok: false, reason: 'groups based on computed values are read-only' }
  if (d.fromKey === d.toKey) {
    if (d.reorderWithinGroup && d.sortsActive) return { ok: false, reason: 'remove the sort to reorder cards by hand' }
    return { ok: true, noop: true, commands: [] } // same group: no data mutation (a position change is view-local)
  }
  const patch = (cell: Cell | null): Plan => ({ ok: true, commands: [{ type: 'row.patch', payload: { pageId: d.pageId, cellChanges: { [def.id]: cell as unknown as Json } } }] })
  const none = d.toKey === NONE_GROUP
  const cell = row.ext.cells[def.id]?.value
  switch (def.kind) {
    case 'select': return none ? patch(null) : patch({ kind: 'select', optionId: d.toKey })
    case 'status': {
      if (none) return { ok: false, reason: 'a status cannot be empty' }
      if (d.mode === 'status_group') {
        const cfg = statusConfig(def.config)
        const opt = cfg.options.find((o) => o.statusGroupId === d.toKey)
        if (!opt) return { ok: false, reason: 'that group has no options' }
        return patch({ kind: 'status', optionId: opt.id })
      }
      return patch({ kind: 'status', optionId: d.toKey })
    }
    case 'checkbox': return patch({ kind: 'checkbox', value: d.toKey === 'true' })
    case 'multi_select':
    case 'people': {
      const cur = cell && (cell.kind === 'multi_select' ? cell.optionIds : cell.kind === 'people' ? cell.principalIds : []) || []
      let next = cur.filter((x) => x !== d.fromKey) // leaves the origin, keeps every other membership
      if (none) {
        if (cur.length > 1) return { ok: true, confirm: 'clear_multiple', commands: [{ type: 'row.patch', payload: { pageId: d.pageId, cellChanges: { [def.id]: def.kind === 'people' ? { kind: 'people', principalIds: [] } : { kind: 'multi_select', optionIds: [] } } } }] }
        next = []
      } else if (!next.includes(d.toKey)) next = [...next, d.toKey]
      return patch(def.kind === 'people' ? { kind: 'people', principalIds: next } : { kind: 'multi_select', optionIds: next })
    }
    case 'relation': {
      const rel = state.relationOf(def.id)
      if (!rel) return { ok: false, reason: 'relation missing' }
      const forward = rel.propertyId === def.id
      const out = (forward ? state.edgesOut(rel.id, d.pageId) : state.edgesIn(rel.id, d.pageId)).map((e) => (forward ? e.toPageId : e.fromPageId))
      const cmds: PlannedCommand[] = []
      const single = forward ? rel.cardinality === 'one' : rel.inverseCardinality === 'one'
      if (d.fromKey !== NONE_GROUP) cmds.push({ type: 'relation.remove', payload: { propertyId: def.id, fromPageId: d.pageId, toPageId: d.fromKey } })
      if (!none) cmds.push({ type: 'relation.add', payload: { propertyId: def.id, fromPageId: d.pageId, toPageId: d.toKey, replace: single } })
      if (none && out.length > 1) return { ok: true, confirm: 'clear_multiple', commands: [{ type: 'relation.replace', payload: { propertyId: def.id, fromPageId: d.pageId, orderedTargetPageIds: [] } }] }
      return { ok: true, commands: cmds }
    }
    case 'text': case 'number': case 'url': case 'email': case 'phone': case 'date':
      return { ok: false, reason: `dropping onto a ${def.kind} group is not supported; edit the value instead` }
    default: return { ok: false, reason: `cannot group by ${def.kind}` }
  }
}

// ───── calendar / timeline ─────

export type DateDrag = { pageId: Id; datePropertyId: Id; mode: 'move' | 'resize_start' | 'resize_end'; days: number; zone: string }

export function planDateDrag(state: DbState, d: DateDrag): Plan {
  const def = state.prop(d.datePropertyId)
  const row = state.row(d.pageId)
  if (!def || !row) return { ok: false, reason: 'not found' }
  if (def.kind !== 'date') return { ok: false, reason: 'this date is computed; edit its inputs instead' }
  const cell = row.ext.cells[def.id]?.value
  if (!cell || cell.kind !== 'date' || !cell.value) return { ok: false, reason: 'the item has no date yet' }
  let next: DateValue
  try {
    next = d.mode === 'move' ? shiftDays(cell.value, d.days, d.zone) : moveEndpoint(cell.value, d.mode === 'resize_start' ? 'start' : 'end', d.days, d.zone)
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  const settings = (state.get('source', row.sourceId)?.settings ?? {}) as { dependency?: { datePropertyId?: Id } }
  if (settings.dependency?.datePropertyId === def.id && d.mode !== 'resize_start')
    return { ok: true, commands: [{ type: 'date.shift', payload: { pageId: d.pageId, datePropertyId: def.id, value: next as unknown as Json, zone: d.zone } }] }
  return { ok: true, commands: [{ type: 'row.patch', payload: { pageId: d.pageId, cellChanges: { [def.id]: { kind: 'date', value: next } as unknown as Json } } }] }
}

export type ScheduleItem = { pageId: Id; title: string; startMs: number; endMs: number; startCivil: string; endCivil: string; allDay: boolean }

/** Items of a date property inside [fromCivil, toCivil], plus the explicit "unscheduled" list. */
export function scheduleModel(state: DbState, rs: Resolver, pageIds: Id[], datePropertyId: Id, fromCivil: string, toCivil: string, zone: string) {
  const def = state.prop(datePropertyId)
  const items: ScheduleItem[] = []
  const unscheduled: Id[] = []
  const lo = startOfDayMs(fromCivil, zone)
  const hi = startOfDayMs(addDays(toCivil, 1), zone)
  for (const id of pageIds) {
    const row = state.row(id)
    if (!row || !def) continue
    const q = rs.value(row, def)
    if (q.c !== 'date') { unscheduled.push(id); continue }
    const iv = dateInterval(q.v, zone)
    if (iv.e <= lo || iv.s >= hi) continue
    items.push({ pageId: id, title: row.page.title, startMs: iv.s, endMs: iv.e, startCivil: civilOf(iv.s, zone), endCivil: civilOf(Math.max(iv.s, iv.e - 1), zone), allDay: q.v.kind === 'date' })
  }
  return { items, unscheduled, editable: def?.kind === 'date' }
}

export function dependencyArrows(state: DbState, sourceId: Id, visible: Set<Id>): { from: Id; to: Id }[] {
  const id = (state.get('source', sourceId)?.settings as { dependencyRelationId?: Id } | undefined)?.dependencyRelationId
  if (!id) return []
  return state.live('edge').filter((e) => e.definitionId === id && visible.has(e.fromPageId) && visible.has(e.toPageId)).map((e) => ({ from: e.fromPageId, to: e.toPageId }))
}

// ───── map ─────

export const MAP_VISIBLE_LIMIT = 100

export function mapModel(state: DbState, rs: Resolver, pageIds: Id[], placePropertyId: Id) {
  const def = state.prop(placePropertyId)
  const pins: { pageId: Id; title: string; lat: number; lon: number; name: string }[] = []
  const unplaced: Id[] = []
  for (const id of pageIds) {
    const row = state.row(id)
    if (!row || !def) continue
    if (!rs.access.canReadProperty(rs.principalId, def, row)) continue
    const c = row.ext.cells[def.id]?.value
    if (c?.kind === 'place' && c.value && c.value.lat !== null && c.value.lon !== null) pins.push({ pageId: id, title: row.page.title, lat: c.value.lat, lon: c.value.lon, name: c.value.name })
    else unplaced.push(id) // missing coordinates or an unresolved address: never geocoded automatically
  }
  return { pins: pins.slice(0, MAP_VISIBLE_LIMIT), truncated: Math.max(0, pins.length - MAP_VISIBLE_LIMIT), totalPins: pins.length, unplaced }
}

// ───── dashboard ─────

export type GlobalFilter = { filter: Filter | null; mappings: Record<Id, Id> } // sourceId -> propertyId the filter's property maps to

/** Effective filter = view filter AND widget-local filter AND the mapped global filter. Unmapped widgets are "not affected". */
export function effectiveFilter(base: Filter | null, local: Filter | null, global: { predicate: { op: string; operand?: Json } | null; mappings: Record<Id, Id> } | null, sourceId: Id): { filter: Filter | null; affected: boolean } {
  const parts: Filter[] = []
  if (base) parts.push(base)
  if (local) parts.push(local)
  const mapped = global?.predicate && global.mappings[sourceId]
  if (global?.predicate && mapped) parts.push({ kind: 'predicate', propertyId: mapped, op: global.predicate.op, operand: global.predicate.operand })
  return { filter: parts.length ? (parts.length === 1 ? parts[0] : { kind: 'and', children: parts }) : null, affected: !!mapped }
}

/** Mappings are suggestions only: similar names never authorize anything. */
export function suggestMappings(state: DbState, fromPropertyId: Id): { sourceId: Id; propertyId: Id }[] {
  const from = state.prop(fromPropertyId)
  if (!from) return []
  return state.live('property').filter((p) => p.sourceId !== from.sourceId && p.kind === from.kind && p.name.toLowerCase() === from.name.toLowerCase()).map((p) => ({ sourceId: p.sourceId, propertyId: p.id }))
}

// ───── feed ─────

/** One view per principal / page / day, counted only after the card was visible for two seconds (P analytics policy). */
export const FEED_VISIBLE_MS = 2000
export const feedViewEventId = (pageId: Id, who: Id, dayCivil: string) => `view:${pageId}:${who}:${dayCivil}`

export function feedCounts(state: DbState, pageId: Id): { views: number; comments: number } {
  const views = state.live('event').filter((e) => e.type === 'view' && e.pageId === pageId).length
  const comments = state.live('comment').filter((c) => c.pageId === pageId && c.propertyId === null).length
  return { views, comments }
}

