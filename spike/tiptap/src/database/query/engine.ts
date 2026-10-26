// The query engine (handoff §10): typed predicates, advanced filters, relative dates, multi-sort, grouping, subgroups, totals,
// search and cursor pagination. Execution order: permission/trash scope -> filter -> search -> full-match aggregates/groups ->
// stable sort -> cursor page. Totals and groups describe the whole matching set, never just the loaded rows.
import type { Definition, Filter, GroupSpec, Id, Json, Query, QueryGroup, QueryPage } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { compareKeys } from '../model/ids.ts'
import { addDays, civilOf, dateInterval, parseCivil, parseIsoInstant, relativeInterval, startOfDayMs, startOfMonth, startOfWeek, type RelativeKind, RELATIVE_KINDS, isCivil } from '../dates.ts'
import { OPS, DESCRIPTORS, type ValueClass } from '../props/registry.ts'
import { cfgOf, optionsOf, statusConfig, type RollupAggregation } from '../props/config.ts'
import { Resolver, type ResolverOptions } from '../resolver.ts'
import type { DbState, Row } from '../state.ts'
import { collationKey, compareCodePoints, matchKey } from '../text.ts'
import { aggregateSafe } from './aggregate.ts'
import { qEmpty, type QValue } from './values.ts'

export const MAX_FILTER_GROUPS = 16
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500

export type SubItemMode = { mode: 'flat' | 'nested'; include: 'all' | 'parents' | 'children' | 'parents_with_children' }

export type QueryRequest = Query & {
  group?: GroupSpec | null
  subgroup?: GroupSpec | null
  totals?: Record<Id, RollupAggregation>
  /** view-specific manual order (page ids); only a tie-breaker after the active sorts */
  manualOrder?: Id[]
  weekStart?: number
  subItems?: SubItemMode
}

export type QueryRow = { pageId: Id; context?: boolean; depth?: number; values: Record<Id, QValue> }

export type QueryResult = Omit<QueryPage, 'rows'> & { rows: QueryRow[]; contextIds: Id[]; matchIds: Id[]; warnings: { code: string; detail: string }[] }

/** Operator family of a property for filtering (derived properties resolve from their static result type). */
export function filterClass(_state: DbState, def: Definition): ValueClass {
  const d = DESCRIPTORS[def.kind]
  if (d.valueClass !== 'derived') return d.valueClass
  let t = 'any'
  if (def.kind === 'formula') t = cfgOf.formula(def).resultType
  else if (def.kind === 'rollup') {
    const agg = cfgOf.rollup(def).aggregation
    t = agg === 'earliest_date' || agg === 'latest_date' || agg === 'date_range' ? 'date' : agg === 'show_original' || agg === 'show_unique' ? 'list' : 'number'
  }
  if (t === 'number') return 'number'
  if (t === 'text') return 'text'
  if (t === 'boolean') return 'checkbox'
  if (t === 'date') return 'date'
  if (t.startsWith('list<page') || t.startsWith('list<person')) return 'members'
  return 'derived'
}

const isQueryable = (state: DbState, def: Definition) => DESCRIPTORS[def.kind].queryable && filterClass(state, def) !== 'derived' && filterClass(state, def) !== 'none'

// ───── filter validation ─────

function countGroups(f: Filter, depth = 0): { groups: number; pathGroups: number } {
  if (f.kind === 'predicate') return { groups: 0, pathGroups: 0 }
  let groups = 1
  let path = 0
  for (const c of f.children) {
    const r = countGroups(c, depth + 1)
    groups += r.groups
    path = Math.max(path, r.pathGroups)
  }
  return { groups, pathGroups: path + 1 }
}

function operandError(op: string, why: string): never {
  return fail('INVALID_FILTER', `operand for ${op}: ${why}`)
}

export function validateFilter(state: DbState, sourceId: Id, f: Filter | null, principalId: Id, access: Resolver['access']): void {
  if (!f) return
  const { groups } = countGroups(f)
  if (groups > MAX_FILTER_GROUPS) fail('INVALID_FILTER', `a filter may contain at most ${MAX_FILTER_GROUPS} groups`)
  const walk = (n: Filter) => {
    if (n.kind !== 'predicate') {
      if (!Array.isArray(n.children)) fail('INVALID_FILTER', 'compound filter needs children')
      n.children.forEach(walk)
      return
    }
    const def = state.prop(n.propertyId)
    if (!def || def.sourceId !== sourceId) fail('INVALID_FILTER', 'unknown property in filter', { propertyId: n.propertyId })
    if (!access.canReadProperty(principalId, def)) fail('ACCESS_DENIED', 'filter uses a property you cannot read', { propertyId: def.id })
    if (!isQueryable(state, def)) fail('INVALID_FILTER', `${def.kind} properties cannot be filtered`, { propertyId: def.id })
    const cls = filterClass(state, def)
    if (!OPS[cls].includes(n.op)) fail('INVALID_FILTER', `operator ${n.op} does not apply to ${def.kind}`, { propertyId: def.id, op: n.op })
    validateOperand(def, cls, n.op, n.operand)
  }
  walk(f)
}

function validateOperand(def: Definition, cls: ValueClass, op: string, operand: Json | undefined) {
  if (op === 'is_empty' || op === 'is_not_empty') return
  switch (cls) {
    case 'text': if (typeof operand !== 'string') operandError(op, 'text expected'); break
    case 'number': if (typeof operand !== 'number' || !Number.isFinite(operand)) operandError(op, 'finite number expected'); break
    case 'checkbox': if (typeof operand !== 'boolean') operandError(op, 'true or false expected'); break
    case 'select':
    case 'status': {
      if (typeof operand !== 'string') operandError(op, 'option id expected')
      if (op === 'group_equals') { if (!statusConfig(def.config).groups.some((g) => g.id === operand)) operandError(op, 'unknown status group') }
      else if (!optionsOf(def).some((o) => o.id === operand)) operandError(op, 'unknown option')
      break
    }
    case 'members':
      if (op === 'contains_any' || op === 'contains_all') { if (!Array.isArray(operand) || operand.some((x) => typeof x !== 'string')) operandError(op, 'array of ids expected') }
      else if (typeof operand !== 'string') operandError(op, 'id expected')
      break
    case 'date': validateDateOperand(op, operand); break
    case 'verification': break
    default: break
  }
}

function asDateBoundary(x: unknown): boolean {
  if (typeof x === 'string') return isCivil(x) || parseIsoInstant(x, 'UTC') !== null
  if (x && typeof x === 'object' && 'start' in x) return asDateBoundary((x as { start: unknown }).start)
  return false
}

function validateDateOperand(op: string, operand: Json | undefined) {
  if (op === 'relative') {
    const o = operand as { kind?: string; n?: number } | null
    if (!o || typeof o !== 'object' || !(RELATIVE_KINDS as string[]).includes(o.kind as string)) operandError(op, `one of ${RELATIVE_KINDS.join(', ')}`)
    if ((o!.kind === 'past_n_days' || o!.kind === 'next_n_days') && !(Number.isInteger(o!.n) && o!.n! > 0)) operandError(op, 'positive whole n expected')
    return
  }
  if (op === 'between') {
    const o = operand as { start?: unknown; end?: unknown } | null
    if (!o || typeof o !== 'object' || !asDateBoundary(o.start) || !asDateBoundary(o.end)) operandError(op, '{start, end} dates expected')
    return
  }
  if (!asDateBoundary(operand)) operandError(op, 'ISO date or date-time expected')
}

// ───── predicate evaluation ─────

function boundary(x: unknown, zone: string, endSide: boolean): number {
  const v = typeof x === 'object' && x && 'start' in (x as object) ? ((endSide ? ((x as { end?: unknown }).end ?? (x as { start: unknown }).start) : (x as { start: unknown }).start) as string) : (x as string)
  if (isCivil(v)) return startOfDayMs(endSide ? addDays(v, 1) : v, zone)
  const ms = parseIsoInstant(v, zone)!
  return endSide ? ms + 1 : ms
}

function operandInterval(operand: unknown, zone: string): { s: number; e: number } {
  if (operand && typeof operand === 'object' && 'start' in operand) {
    const o = operand as { start: string; end?: string | null }
    return { s: boundary(o.start, zone, false), e: boundary(o.end ?? o.start, zone, true) }
  }
  return { s: boundary(operand, zone, false), e: boundary(operand, zone, true) }
}

export type EvalCtx = { zone: string; nowMs: number; weekStart: number }

export function evalPredicate(cls: ValueClass, def: Definition, op: string, operand: Json | undefined, q: QValue, row: Row, ec: EvalCtx): boolean {
  if (q.c === 'blocked') return false // a restricted / pending / errored value never matches (and is not "empty")
  const empty = qEmpty(q)
  if (op === 'is_empty') return empty
  if (op === 'is_not_empty') return !empty
  switch (cls) {
    case 'text': {
      const hay = q.c === 'text' ? matchKey(q.text) : ''
      const needle = matchKey(String(operand ?? ''))
      switch (op) {
        case 'equals': return !empty && hay === needle
        case 'not_equals': return empty || hay !== needle
        case 'contains': return !empty && hay.includes(needle)
        case 'not_contains': return empty || !hay.includes(needle)
        case 'starts_with': return !empty && hay.startsWith(needle)
        case 'ends_with': return !empty && hay.endsWith(needle)
      }
      break
    }
    case 'number': {
      if (q.c !== 'number') return op === 'not_equals'
      const o = operand as number
      switch (op) {
        case 'equals': return q.n === o
        case 'not_equals': return q.n !== o
        case 'gt': return q.n > o
        case 'gte': return q.n >= o
        case 'lt': return q.n < o
        case 'lte': return q.n <= o
      }
      break
    }
    case 'checkbox': return q.c === 'bool' && q.b === operand
    case 'select':
    case 'status': {
      const id = q.c === 'members' ? q.ids[0] : undefined
      if (op === 'equals') return id === operand
      if (op === 'not_equals') return id !== operand
      if (op === 'group_equals') return id !== undefined && statusConfig(def.config).options.find((o) => o.id === id)?.statusGroupId === operand
      break
    }
    case 'members': {
      const ids = q.c === 'members' ? q.ids : []
      switch (op) {
        case 'contains': return ids.includes(operand as string)
        case 'not_contains': return !ids.includes(operand as string)
        case 'contains_any': return (operand as string[]).some((x) => ids.includes(x))
        case 'contains_all': return (operand as string[]).every((x) => ids.includes(x))
      }
      break
    }
    case 'date': {
      if (q.c !== 'date') return false
      const r = dateInterval(q.v, ec.zone)
      if (op === 'relative') {
        const o = operand as { kind: RelativeKind; n?: number }
        const rel = relativeInterval(o.kind, ec.nowMs, ec.zone, ec.weekStart, o.n)
        return r.s < rel.e && rel.s < r.e
      }
      if (op === 'between') {
        const b = operand as { start: unknown; end: unknown }
        const o = { s: boundary(b.start, ec.zone, false), e: boundary(b.end, ec.zone, true) }
        return r.s < o.e && o.s < r.e
      }
      const o = operandInterval(operand, ec.zone)
      switch (op) {
        case 'equals': return r.s < o.e && o.s < r.e
        case 'before': return r.e <= o.s
        case 'after': return r.s >= o.e
        case 'on_or_before': return r.s < o.e
        case 'on_or_after': return r.e > o.s
      }
      break
    }
    case 'verification': {
      const cell = row.ext.cells[def.id]?.value
      if (cell?.kind !== 'verification') return false
      const expired = cell.value.expiresAt !== null && cell.value.expiresAt <= ec.nowMs
      if (op === 'equals') return operand === 'expired' ? cell.value.state === 'verified' && expired : operand === 'verified' ? cell.value.state === 'verified' && !expired : cell.value.state === 'unverified'
      if (op === 'verifier') return cell.value.verifierId === operand
      if (op === 'expired') return expired === operand
      break
    }
  }
  return fail('INVALID_FILTER', `cannot evaluate ${op} on ${def.kind}`)
}

function evalFilter(f: Filter, row: Row, rs: Resolver, state: DbState, ec: EvalCtx, memo: Map<string, QValue>): boolean {
  if (f.kind !== 'predicate') {
    if (f.kind === 'and') return f.children.every((c) => evalFilter(c, row, rs, state, ec, memo))
    return f.children.length === 0 ? true : f.children.some((c) => evalFilter(c, row, rs, state, ec, memo))
  }
  const def = state.prop(f.propertyId)!
  const key = `${row.page.id}|${def.id}`
  let q = memo.get(key)
  if (!q) (q = rs.value(row, def), memo.set(key, q))
  return evalPredicate(filterClass(state, def), def, f.op, f.operand, q, row, ec)
}

/** Does one row satisfy a filter right now? (workflow view scopes, dashboard checks, "outside this view" notices) */
export function matchesFilter(state: DbState, rs: Resolver, filter: Filter | null, row: Row, nowMs: number, zone: string, weekStart = 6): boolean {
  if (!filter) return true
  validateFilter(state, row.sourceId, filter, rs.principalId, rs.access)
  return evalFilter(filter, row, rs, state, { zone, nowMs, weekStart }, new Map())
}

// ───── ordering ─────

const STATE_RANK: Record<string, number> = { error: 2, pending: 3, restricted: 4 }
const kindRank = (q: QValue) => (q.c === 'blocked' ? (STATE_RANK[q.state] ?? 2) : qEmpty(q) ? 1 : 0)

function memberLabel(rs: Resolver, q: QValue & { c: 'members' }, id: Id): string {
  if (q.shape === 'relation') return collationKey(rs.title(id) ?? '')
  if (q.shape === 'people' || q.shape === 'created_by' || q.shape === 'last_edited_by') return collationKey(rs.access.principal(id)?.displayName ?? '')
  return id
}

function compareValuesQ(a: QValue, b: QValue, def: Definition, rs: Resolver, zone: string): number {
  if (a.c === 'members' && b.c === 'members') {
    if (def.kind === 'status') {
      const cfg = statusConfig(def.config)
      const rankOf = (id: Id) => {
        const o = cfg.options.find((x) => x.id === id)
        const g = o ? cfg.groups.findIndex((x) => x.id === o.statusGroupId) : 99
        return [g, o ? cfg.options.indexOf(o) : 999]
      }
      const [ga, oa] = rankOf(a.ids[0])
      const [gb, ob] = rankOf(b.ids[0])
      return ga - gb || oa - ob
    }
    if (def.kind === 'select' || def.kind === 'multi_select') {
      const opts = optionsOf(def)
      const ranks = (q: typeof a) => q.ids.map((id) => opts.findIndex((o) => o.id === id)).map((i) => (i < 0 ? 999 : i)).sort((x, y) => x - y)
      const ra = ranks(a)
      const rb = ranks(b)
      for (let i = 0; i < Math.min(ra.length, rb.length); i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
      return ra.length - rb.length
    }
    const la = a.ids.map((id) => memberLabel(rs, a, id)).sort(compareCodePoints)
    const lb = b.ids.map((id) => memberLabel(rs, b, id)).sort(compareCodePoints)
    for (let i = 0; i < Math.min(la.length, lb.length); i++) {
      const c = compareCodePoints(la[i], lb[i])
      if (c) return c
    }
    return la.length - lb.length || compareKeys([...a.ids].sort().join(','), [...b.ids].sort().join(','))
  }
  if (a.c === 'number' && b.c === 'number') return a.n < b.n ? -1 : a.n > b.n ? 1 : 0
  if (a.c === 'bool' && b.c === 'bool') return Number(a.b) - Number(b.b)
  if (a.c === 'text' && b.c === 'text') return compareCodePoints(collationKey(a.text), collationKey(b.text))
  if (a.c === 'date' && b.c === 'date') {
    const x = dateInterval(a.v, zone)
    const y = dateInterval(b.v, zone)
    return x.s < y.s ? -1 : x.s > y.s ? 1 : x.e < y.e ? -1 : x.e > y.e ? 1 : 0
  }
  return 0
}

export function isSortable(_state: DbState, def: Definition): boolean {
  if (!DESCRIPTORS[def.kind].queryable) return false
  if (def.kind === 'rollup') {
    const agg = cfgOf.rollup(def).aggregation
    return !['show_original', 'show_unique', 'date_range'].includes(agg) // rollups sort only when the result is a scalar
  }
  if (def.kind === 'formula') return !cfgOf.formula(def).resultType.startsWith('list')
  return def.kind !== 'files'
}

// ───── grouping ─────

export const NONE_GROUP = '__none__'

type GroupKey = { key: string; label: string; memberId: Id | null; rank: number }

function groupKeys(rs: Resolver, def: Definition, spec: GroupSpec, row: Row, ec: EvalCtx): GroupKey[] {
  const q = rs.value(row, def)
  const none: GroupKey = { key: NONE_GROUP, label: '', memberId: null, rank: Number.MAX_SAFE_INTEGER }
  if (q.c === 'blocked') return [none]
  const mode = spec.mode ?? (def.kind === 'status' || def.kind === 'select' || def.kind === 'multi_select' ? 'option' : 'exact')
  if (qEmpty(q) && def.kind !== 'checkbox') return [none]
  if (q.c === 'members') {
    if (mode === 'status_group' && def.kind === 'status') {
      const cfg = statusConfig(def.config)
      const o = cfg.options.find((x) => x.id === q.ids[0])
      const gi = cfg.groups.findIndex((g) => g.id === o?.statusGroupId)
      return gi < 0 ? [none] : [{ key: cfg.groups[gi].id, label: cfg.groups[gi].label, memberId: cfg.groups[gi].id, rank: gi }]
    }
    const opts = optionsOf(def)
    return q.ids.map((id, i) => {
      const oi = opts.findIndex((o) => o.id === id)
      if (oi >= 0) return { key: id, label: opts[oi].name, memberId: id, rank: oi }
      return { key: id, label: q.shape === 'relation' ? (rs.title(id) ?? '') : (rs.access.principal(id)?.displayName ?? id), memberId: id, rank: 1000 + i }
    })
  }
  if (q.c === 'bool') return [{ key: String(q.b), label: String(q.b), memberId: null, rank: q.b ? 1 : 0 }]
  if (q.c === 'number') {
    if (mode === 'bucket') {
      const size = spec.bucketSize ?? 0
      const start = spec.bucketStart ?? 0
      if (!(size > 0)) fail('INVALID_FILTER', 'bucket size must be > 0')
      if (q.n < start) return [{ key: 'under', label: 'under', memberId: null, rank: -1 }]
      const i = Math.floor((q.n - start) / size)
      return [{ key: `b${i}`, label: `${start + i * size}–${start + (i + 1) * size}`, memberId: null, rank: i }]
    }
    return [{ key: `n:${q.n}`, label: String(q.n), memberId: null, rank: q.n }]
  }
  if (q.c === 'text') {
    const t = mode === 'prefix' ? [...q.text].slice(0, spec.prefixLength ?? 1).join('') : q.text
    const k = collationKey(t)
    return [{ key: `t:${k}`, label: t, memberId: null, rank: 0 }]
  }
  if (q.c === 'date') {
    const startMs = dateInterval(q.v, ec.zone).s
    const day = civilOf(startMs, ec.zone)
    switch (mode) {
      case 'week': { const w = startOfWeek(day, ec.weekStart); return [{ key: w, label: w, memberId: null, rank: startMs }] }
      case 'month': { const m = startOfMonth(day).slice(0, 7); return [{ key: m, label: m, memberId: null, rank: startMs }] }
      case 'year': { const y = String(parseCivil(day).y); return [{ key: y, label: y, memberId: null, rank: startMs }] }
      case 'relative': {
        const today = civilOf(ec.nowMs, ec.zone)
        const d = (a: string, b: string) => (new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000
        const delta = d(day, today)
        const [k, rank] = delta < 0 ? ['before', 0] : delta === 0 ? ['today', 1] : delta === 1 ? ['tomorrow', 2] : delta <= 7 ? ['next_7_days', 3] : ['later', 4]
        return [{ key: k as string, label: k as string, memberId: null, rank: rank as number }]
      }
      default: return [{ key: day, label: day, memberId: null, rank: startMs }]
    }
  }
  return [none]
}

function buildGroups(rs: Resolver, def: Definition, spec: GroupSpec, rows: Row[], ec: EvalCtx, order: Id[] | undefined): QueryGroup[] {
  const map = new Map<string, { gk: GroupKey; ids: Id[]; seen: Set<Id> }>()
  for (const row of rows) {
    for (const gk of groupKeys(rs, def, spec, row, ec)) {
      const e = map.get(gk.key) ?? map.set(gk.key, { gk, ids: [], seen: new Set() }).get(gk.key)!
      if (!e.seen.has(row.page.id)) (e.seen.add(row.page.id), e.ids.push(row.page.id))
    }
  }
  let list = [...map.values()]
  list.sort((a, b) => {
    if (a.gk.key === NONE_GROUP || b.gk.key === NONE_GROUP) return a.gk.key === NONE_GROUP ? (b.gk.key === NONE_GROUP ? 0 : 1) : -1
    return a.gk.rank - b.gk.rank || compareCodePoints(a.gk.label, b.gk.label) || compareKeys(a.gk.key, b.gk.key)
  })
  if (order?.length) {
    const pos = new Map(order.map((k, i) => [k, i]))
    list = list.sort((a, b) => (pos.get(a.gk.key) ?? 1e9) - (pos.get(b.gk.key) ?? 1e9))
  }
  const hidden = new Set(spec.hidden ?? [])
  return list.filter((e) => !hidden.has(e.gk.key)).map((e) => ({ key: e.gk.key, label: e.gk.label, memberId: e.gk.memberId, pageIds: e.ids, count: e.ids.length }))
}

// ───── cursor ─────

function signature(req: QueryRequest): string {
  const s = JSON.stringify([req.sourceId, req.filter, req.sorts, req.search, req.principalId, req.group, req.subgroup])
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const enc = (o: object) => btoa(JSON.stringify(o))
function decodeCursor(c: string): { g: number; o: number; h: string } {
  try {
    return JSON.parse(atob(c))
  } catch {
    return fail('STALE_CURSOR', 'cursor is not valid')
  }
}

// ───── the engine ─────

export function runQuery(state: DbState, req: QueryRequest, resolverOverride?: Resolver): QueryResult {
  const zone = req.timeZone
  const nowMs = Date.parse(req.now)
  if (!Number.isFinite(nowMs)) fail('INVALID_FILTER', 'now must be an ISO instant')
  const weekStart = req.weekStart ?? 6
  const ec: EvalCtx = { zone, nowMs, weekStart }
  const ropts: ResolverOptions = { principalId: req.principalId, nowMs, zone, weekStart }
  const rs = resolverOverride ?? new Resolver(state, ropts)
  const source = state.get('source', req.sourceId)
  if (!source || source.deletedAt !== null) fail('NOT_FOUND', 'source not found', { sourceId: req.sourceId })
  if (source!.vaultId !== req.vaultId) fail('SCHEMA_MISMATCH', 'source belongs to another vault')
  if (!rs.access.principal(req.principalId)) fail('ACCESS_DENIED', 'unknown principal')
  const warnings: { code: string; detail: string }[] = []

  // 1. validate everything the principal asked for BEFORE touching any row (no ordering / count may leak a hidden column)
  validateFilter(state, req.sourceId, req.filter, req.principalId, rs.access)
  for (const s of req.sorts) {
    const d = state.prop(s.propertyId)
    if (!d || d.sourceId !== req.sourceId) fail('INVALID_FILTER', 'unknown sort property', { propertyId: s.propertyId })
    if (!rs.access.canReadProperty(req.principalId, d!)) fail('ACCESS_DENIED', 'sort uses a property you cannot read', { propertyId: s.propertyId })
    if (!isSortable(state, d!)) fail('INVALID_FILTER', `${d!.kind} properties cannot be sorted`, { propertyId: s.propertyId })
    if (s.direction !== 'asc' && s.direction !== 'desc') fail('INVALID_FILTER', 'sort direction must be asc or desc')
  }
  for (const spec of [req.group, req.subgroup]) {
    if (!spec) continue
    const d = state.prop(spec.propertyId)
    if (!d || d.sourceId !== req.sourceId) fail('INVALID_FILTER', 'unknown group property', { propertyId: spec.propertyId })
    if (!rs.access.canReadProperty(req.principalId, d!)) fail('ACCESS_DENIED', 'group uses a property you cannot read', { propertyId: spec.propertyId })
    if (['button', 'files', 'connected'].includes(d!.kind) || (d!.kind === 'formula' && cfgOf.formula(d!).resultType.startsWith('list<list'))) fail('INVALID_FILTER', `cannot group by ${d!.kind}`, { propertyId: d!.id })
  }
  for (const pid of Object.keys(req.totals ?? {})) {
    const d = state.prop(pid)
    if (!d || d.sourceId !== req.sourceId) fail('INVALID_FILTER', 'unknown total property', { propertyId: pid })
    if (!rs.access.canReadProperty(req.principalId, d!)) fail('ACCESS_DENIED', 'totals use a property you cannot read', { propertyId: pid })
  }

  // 2. scope: visible, live rows
  const memo = new Map<string, QValue>()
  let rows = state.rows(req.sourceId).filter((r) => rs.access.canSeeRow(req.principalId, r))

  // 3. filter
  if (req.filter) rows = rows.filter((r) => evalFilter(req.filter!, r, rs, state, ec, memo))

  // 4. search: every word must appear in the union of title + property projections (never the body)
  const words = matchKey(req.search ?? '').split(/\s+/).filter(Boolean)
  if (words.length) {
    const defs = state.props(req.sourceId)
    rows = rows.filter((r) => {
      const hay = rs.searchProjection(r, defs).join(' ')
      return words.every((w) => hay.includes(w))
    })
  }

  // sub-items: which rows take part
  const sub = req.subItems
  const matchSet = new Set(rows.map((r) => r.page.id))
  if (sub && sub.include !== 'all') {
    const keep = (r: Row) => {
      const hasParent = !!r.ext.parentItemId
      if (sub.include === 'parents') return !hasParent
      if (sub.include === 'children') return hasParent
      return !hasParent || matchSet.has(r.ext.parentItemId!)
    }
    rows = rows.filter(keep)
    if (sub.include === 'parents_with_children') {
      const extra = state.rows(req.sourceId).filter((r) => r.ext.parentItemId && matchSet.has(r.ext.parentItemId) && !rows.includes(r) && rs.access.canSeeRow(req.principalId, r))
      rows = [...rows, ...extra]
    }
  }

  // 5. whole-set aggregates and groups (describe all matches, independent of paging)
  const totalsOut: Record<string, Json> = {}
  for (const [pid, op] of Object.entries(req.totals ?? {})) {
    const d = state.prop(pid)!
    const r = aggregateSafe(op, { values: rows.map((row) => rs.value(row, d)), zone })
    totalsOut[pid] = { op, value: r as unknown as Json }
  }
  const groupDef = req.group ? state.prop(req.group.propertyId)! : null
  const groups = req.group ? buildGroups(rs, groupDef!, req.group, rows, ec, req.group.order) : []
  if (req.group && req.subgroup) {
    const subDef = state.prop(req.subgroup.propertyId)!
    for (const g of groups) {
      const inGroup = g.pageIds.map((id) => state.row(id)!).filter(Boolean)
      ;(g as QueryGroup & { subgroups?: QueryGroup[] }).subgroups = buildGroups(rs, subDef, req.subgroup, inGroup, ec, req.subgroup.order)
    }
  }

  // 6. stable sort
  const manual = new Map((req.manualOrder ?? []).map((id, i) => [id, i]))
  const sortDefs = req.sorts.map((s) => ({ s, def: state.prop(s.propertyId)! }))
  const keyFor = (row: Row, def: Definition) => {
    const k = `${row.page.id}|${def.id}`
    let q = memo.get(k)
    if (!q) (q = rs.value(row, def), memo.set(k, q))
    return q
  }
  const cmp = (a: Row, b: Row): number => {
    for (const { s, def } of sortDefs) {
      const qa = keyFor(a, def)
      const qb = keyFor(b, def)
      const ra = kindRank(qa)
      const rb = kindRank(qb)
      if (ra !== rb) return ra - rb // empties / errors / pending / restricted always last, in both directions
      if (ra !== 0) continue // both empty / both in the same blocked state: the next sort decides
      const c = compareValuesQ(qa, qb, def, rs, zone)
      if (c) return s.direction === 'asc' ? c : -c
    }
    const ma = manual.get(a.page.id)
    const mb = manual.get(b.page.id)
    if (ma !== undefined || mb !== undefined) {
      const d = (ma ?? 1e9) - (mb ?? 1e9)
      if (d) return d
    }
    return compareKeys(a.ext.sortKey, b.ext.sortKey) || compareKeys(a.page.id, b.page.id)
  }
  rows = [...rows].sort(cmp)

  // nested sub-items: tree order, ancestors of a match are shown as context rows
  let ordered: { row: Row; context: boolean; depth: number }[]
  const contextIds: Id[] = []
  if (sub?.mode === 'nested') {
    const inSet = new Set(rows.map((r) => r.page.id))
    const need = new Map<Id, Row>()
    for (const r of rows) {
      for (let p = r.ext.parentItemId; p; ) {
        const pr = state.row(p)
        if (!pr || pr.page.deletedAt !== null || need.has(p) || inSet.has(p)) break
        if (!rs.access.canSeeRow(req.principalId, pr)) break
        need.set(p, pr)
        contextIds.push(p)
        p = pr.ext.parentItemId
      }
    }
    const all = [...rows, ...need.values()]
    const byParent = new Map<Id | null, Row[]>()
    const present = new Set(all.map((r) => r.page.id))
    for (const r of all) {
      const parent = r.ext.parentItemId && present.has(r.ext.parentItemId) ? r.ext.parentItemId : null
      ;(byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(r)
    }
    for (const list of byParent.values()) list.sort(cmp)
    ordered = []
    const visit = (parent: Id | null, depth: number) => {
      for (const r of byParent.get(parent) ?? []) {
        ordered.push({ row: r, context: need.has(r.page.id), depth })
        visit(r.page.id, depth + 1)
      }
    }
    visit(null, 0)
  } else ordered = rows.map((row) => ({ row, context: false, depth: 0 }))

  // 7. cursor page
  const limit = Math.max(1, Math.min(req.limit || DEFAULT_LIMIT, MAX_LIMIT))
  const sig = signature(req)
  let offset = 0
  if (req.cursor) {
    const c = decodeCursor(req.cursor)
    if (c.g !== state.generation || c.h !== sig) fail('STALE_CURSOR', 'data changed since this page was loaded; restart from the visible anchor')
    offset = c.o
  }
  if (req.expectedGeneration !== undefined && req.expectedGeneration !== state.generation && req.cursor) fail('STALE_CURSOR', 'generation changed')
  const slice = ordered.slice(offset, offset + limit)
  const proj = (req.projection ?? []).map((id) => state.prop(id)).filter((d): d is Definition => !!d)
  const outRows: QueryRow[] = slice.map(({ row, context, depth }) => {
    const values: Record<Id, QValue> = {}
    for (const d of proj) values[d.id] = rs.value(row, d)
    return { pageId: row.page.id, ...(context ? { context: true } : {}), ...(sub?.mode === 'nested' ? { depth } : {}), values }
  })
  const next = offset + limit < ordered.length ? enc({ g: state.generation, o: offset + limit, h: sig }) : null
  const matchIds = rows.map((r) => r.page.id)
  return {
    generation: state.generation,
    pageIds: slice.map((s) => s.row.page.id),
    rows: outRows,
    total: rows.length, // distinct Page IDs matched, regardless of how many groups a row appears in
    groups,
    totals: totalsOut,
    nextCursor: next,
    incomplete: false,
    diagnostics: warnings,
    contextIds,
    matchIds,
    warnings,
  }
}

/** Convenience used by tests and the UI: a request with sane defaults. */
export function makeQuery(state: DbState, sourceId: Id, principalId: Id, nowIso: string, zone: string, over: Partial<QueryRequest> = {}): QueryRequest {
  return { vaultId: state.vaultId, sourceId, principalId, filter: null, sorts: [], search: '', projection: [], limit: DEFAULT_LIMIT, now: nowIso, timeZone: zone, ...over }
}

