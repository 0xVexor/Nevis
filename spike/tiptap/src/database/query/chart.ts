// Chart data and SVG export (handoff §17.6). Data always comes from the full filtered query, never from loaded rows; the chart is
// read-only; a click opens a drill-down table filter. Caps are disclosed, not silently applied.
import type { Definition, Filter, Id, Json } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { relativeInterval, civilOf, type RelativeKind } from '../dates.ts'
import { cfgOf, type RollupAggregation } from '../props/config.ts'
import { Resolver } from '../resolver.ts'
import type { DbState } from '../state.ts'
import { NONE_GROUP, runQuery, makeQuery, type QueryRequest } from './engine.ts'
import { aggregateSafe } from './aggregate.ts'
import type { QValue } from './values.ts'

export const CHART_MAX_CATEGORIES = 200
export const CHART_MAX_SERIES = 50

export type ChartType = 'bar_vertical' | 'bar_horizontal' | 'line' | 'donut' | 'number'
export type Measure = { kind: 'count' } | { kind: 'agg'; propertyId: Id; op: 'sum' | 'average' | 'median' | 'min' | 'max' | 'range' | 'count_values' | 'count_unique' | 'count_empty' | 'count_not_empty' }

export type ChartRequest = {
  sourceId: Id
  principalId: Id
  now: string
  zone: string
  type: ChartType
  categoryPropertyId?: Id
  dateBucket?: 'day' | 'week' | 'month' | 'year'
  seriesPropertyId?: Id
  measure: Measure
  filter?: Filter | null
  search?: string
  order?: 'category' | 'value_desc' | 'value_asc'
  hideEmpty?: boolean
  zeroBaseline?: boolean
  comparison?: { datePropertyId: Id; current: RelativeKind; previous: RelativeKind }
  weekStart?: number
}

export type ChartData = {
  type: ChartType
  categories: { key: string; label: string; total: number | null; series: Record<string, number | null> }[]
  series: { key: string; label: string }[]
  total: number | null
  comparison?: { current: number | null; previous: number | null; delta: number | null }
  warnings: { code: string; detail: string }[]
  empty: boolean
}

const AXIS_BLOCKED = ['button', 'files', 'unique_id', 'rollup', 'connected']

function checkAxis(state: DbState, id: Id, what: string): Definition {
  const d = state.prop(id)
  if (!d) return fail('INVALID_VALUE', `${what}: unknown property`)
  if (AXIS_BLOCKED.includes(d.kind) || (d.kind === 'formula' && cfgOf.formula(d).resultType.startsWith('list'))) fail('INVALID_VALUE', `${what}: a ${d.kind} property cannot be a chart axis`)
  return d
}

function measureOf(rs: Resolver, state: DbState, m: Measure, pageIds: Id[], zone: string): number | null {
  if (m.kind === 'count') return pageIds.length
  const def = state.prop(m.propertyId)!
  const values: QValue[] = pageIds.map((id) => rs.value(state.row(id)!, def))
  const r = aggregateSafe(m.op as RollupAggregation, { values, zone })
  return r.c === 'number' ? r.n : null
}

export function chartData(state: DbState, req: ChartRequest): ChartData {
  const warnings: ChartData['warnings'] = []
  if (req.measure.kind === 'agg') {
    const md = checkAxis(state, req.measure.propertyId, 'measure')
    if (!['number', 'formula', 'checkbox'].includes(md.kind) && !['count_values', 'count_unique', 'count_empty', 'count_not_empty'].includes(req.measure.op)) fail('INVALID_VALUE', 'measure: choose a Number property or a count')
  }
  const cat = req.categoryPropertyId ? checkAxis(state, req.categoryPropertyId, 'category') : null
  const ser = req.seriesPropertyId ? checkAxis(state, req.seriesPropertyId, 'series') : null
  if (req.type !== 'number' && !cat) fail('INVALID_VALUE', 'category: choose a property for the axis')
  const base: Partial<QueryRequest> = {
    filter: req.filter ?? null, search: req.search ?? '', limit: 500, weekStart: req.weekStart,
    group: cat ? { propertyId: cat.id, mode: cat.kind === 'date' || cat.kind === 'created_time' || cat.kind === 'last_edited_time' ? (req.dateBucket ?? 'month') : undefined } : null,
    subgroup: ser ? { propertyId: ser.id } : null,
  }
  const rs = new Resolver(state, { principalId: req.principalId, nowMs: Date.parse(req.now), zone: req.zone, weekStart: req.weekStart ?? 6 })
  const res = runQuery(state, makeQuery(state, req.sourceId, req.principalId, req.now, req.zone, base), rs)
  const total = measureOf(rs, state, req.measure, res.matchIds, req.zone)

  if (req.type === 'number') {
    const out: ChartData = { type: 'number', categories: [], series: [], total, warnings, empty: res.matchIds.length === 0 }
    if (req.comparison) {
      const c = req.comparison
      const range = (k: RelativeKind) => {
        const iv = relativeInterval(k, Date.parse(req.now), req.zone, req.weekStart ?? 6)
        return { start: civilOf(iv.s, req.zone), end: civilOf(iv.e - 1, req.zone) }
      }
      const val = (k: RelativeKind) => {
        const r = runQuery(state, makeQuery(state, req.sourceId, req.principalId, req.now, req.zone, { ...base, group: null, subgroup: null, filter: { kind: 'and', children: [...(req.filter ? [req.filter] : []), { kind: 'predicate', propertyId: c.datePropertyId, op: 'between', operand: range(k) as unknown as Json }] } }), rs)
        return measureOf(rs, state, req.measure, r.matchIds, req.zone)
      }
      const cur = val(c.current)
      const prev = val(c.previous)
      out.comparison = { current: cur, previous: prev, delta: cur !== null && prev !== null ? cur - prev : null }
    }
    return out
  }

  let groups = res.groups.map((g) => ({ key: g.key, label: g.key === NONE_GROUP ? '' : g.label, pageIds: g.pageIds, sub: (g as { subgroups?: typeof res.groups }).subgroups }))
  if (req.hideEmpty) groups = groups.filter((g) => g.key !== NONE_GROUP)
  const seriesMap = new Map<string, string>()
  const categories = groups.map((g) => {
    const seriesValues: Record<string, number | null> = {}
    if (g.sub) for (const s of g.sub) { seriesMap.set(s.key, s.key === NONE_GROUP ? '' : s.label); seriesValues[s.key] = measureOf(rs, state, req.measure, s.pageIds, req.zone) }
    return { key: g.key, label: g.label, total: measureOf(rs, state, req.measure, g.pageIds, req.zone), series: seriesValues }
  })
  if (req.order === 'value_desc') categories.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity))
  if (req.order === 'value_asc') categories.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity))
  let series = [...seriesMap].map(([key, label]) => ({ key, label }))
  let cats = categories
  if (cats.length > CHART_MAX_CATEGORIES) { warnings.push({ code: 'CATEGORIES_TRUNCATED', detail: `${cats.length - CHART_MAX_CATEGORIES} more categories are not shown` }); cats = cats.slice(0, CHART_MAX_CATEGORIES) }
  if (series.length > CHART_MAX_SERIES) { warnings.push({ code: 'SERIES_TRUNCATED', detail: `${series.length - CHART_MAX_SERIES} more series are not shown` }); series = series.slice(0, CHART_MAX_SERIES) }
  return { type: req.type, categories: cats, series, total, warnings, empty: res.matchIds.length === 0 }
}

/** The table filter a chart click opens: the category (and series) become equality / membership predicates on top of the chart filter. */
export function drilldownFilter(state: DbState, req: ChartRequest, categoryKey: string, seriesKey?: string): Filter | null {
  const parts: Filter[] = []
  if (req.filter) parts.push(req.filter)
  const add = (propertyId: Id | undefined, key: string | undefined, bucket?: ChartRequest['dateBucket']) => {
    if (!propertyId || key === undefined) return
    const d = state.prop(propertyId)
    if (!d) return
    if (key === NONE_GROUP) return void parts.push({ kind: 'predicate', propertyId, op: 'is_empty' })
    switch (d.kind) {
      case 'select': case 'status': return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key })
      case 'multi_select': case 'people': case 'relation': return void parts.push({ kind: 'predicate', propertyId, op: 'contains', operand: key })
      case 'checkbox': return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key === 'true' })
      case 'date': case 'created_time': case 'last_edited_time': {
        const start = bucket === 'year' ? `${key}-01-01` : bucket === 'month' ? `${key}-01` : key
        const end = bucket === 'year' ? `${key}-12-31` : bucket === 'month' ? `${key}-31` : bucket === 'week' ? addWeek(key) : key
        return void parts.push({ kind: 'predicate', propertyId, op: 'between', operand: { start, end: bucket === 'month' ? lastOfMonth(key) : end } })
      }
      case 'number': return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: Number(key.replace(/^n:/, '')) })
      default: return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key.replace(/^t:/, '') })
    }
  }
  add(req.categoryPropertyId, categoryKey, req.dateBucket)
  add(req.seriesPropertyId, seriesKey)
  return parts.length ? (parts.length === 1 ? parts[0] : { kind: 'and', children: parts }) : null
}
function addWeek(civil: string) {
  const d = new Date(civil + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}
function lastOfMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

// ───── SVG export (accessible, no external fonts) ─────

const PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899']
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function chartToSvg(d: ChartData, o: { title: string; width?: number; height?: number; rtl?: boolean; unassignedLabel?: string; xTitle?: string; yTitle?: string } = { title: '' }): string {
  const W = o.width ?? 640
  const H = o.height ?? 360
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Tahoma, sans-serif" font-size="12"'
  const label = (c: { key: string; label: string }) => (c.key === NONE_GROUP ? (o.unassignedLabel ?? 'Unassigned') : c.label)
  const summary = d.type === 'number' ? `${o.title}: ${d.total ?? 'no value'}` : `${o.title}: ${d.categories.map((c) => `${label(c)} ${c.total ?? 0}`).join(', ')}`
  const head = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" direction="${o.rtl ? 'rtl' : 'ltr'}"><title id="t">${esc(o.title)}</title><desc id="d">${esc(summary)}</desc><rect width="${W}" height="${H}" fill="#ffffff"/>`
  if (d.type === 'number') return `${head}<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="48" font-weight="600" fill="#111827" ${font}>${d.total ?? '–'}</text></svg>`
  if (d.type === 'donut') {
    const sum = d.categories.reduce((a, c) => a + Math.max(0, c.total ?? 0), 0) || 1
    let a0 = -Math.PI / 2
    const cx = W / 2
    const cy = H / 2
    const r = Math.min(W, H) / 2 - 30
    const arcs = d.categories.map((c, i) => {
      const frac = Math.max(0, c.total ?? 0) / sum
      const a1 = a0 + frac * Math.PI * 2
      const large = frac > 0.5 ? 1 : 0
      const p = (a: number, rr: number) => `${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`
      const path = frac >= 0.9999 ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} L ${cx - 0.01} ${cy - r * 0.6} A ${r * 0.6} ${r * 0.6} 0 1 0 ${cx} ${cy - r * 0.6} Z` : `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, r * 0.6)} A ${r * 0.6} ${r * 0.6} 0 ${large} 0 ${p(a0, r * 0.6)} Z`
      a0 = a1
      return `<path data-cat="${esc(c.key)}" d="${path}" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(label(c))}: ${c.total ?? 0}</title></path>`
    })
    return `${head}${arcs.join('')}</svg>`
  }
  const left = 56
  const bottom = 48
  const top = 24
  const plotW = W - left - 16
  const plotH = H - top - bottom
  const keys = d.series.length ? d.series.map((s) => s.key) : ['_']
  const val = (c: ChartData['categories'][number], k: string) => (k === '_' ? c.total : c.series[k]) ?? 0
  const max = Math.max(1, ...d.categories.flatMap((c) => keys.map((k) => val(c, k))))
  const min = d.categories.length && !keys.some(() => false) ? Math.min(0, ...d.categories.flatMap((c) => keys.map((k) => val(c, k)))) : 0
  const span = max - min || 1
  const out: string[] = []
  if (d.type === 'bar_vertical' || d.type === 'bar_horizontal') {
    const horizontal = d.type === 'bar_horizontal'
    const n = d.categories.length || 1
    d.categories.forEach((c, ci) => {
      keys.forEach((k, ki) => {
        const v = val(c, k)
        const frac = (v - min) / span
        const zero = (0 - min) / span
        const bandSize = (horizontal ? plotH : plotW) / n
        const barSize = (bandSize * 0.8) / keys.length
        const offset = ci * bandSize + bandSize * 0.1 + ki * barSize
        const color = PALETTE[(d.series.length ? ki : ci) % PALETTE.length]
        if (horizontal) out.push(`<rect data-cat="${esc(c.key)}" data-series="${esc(k)}" x="${left + Math.min(frac, zero) * plotW}" y="${top + offset}" width="${Math.abs(frac - zero) * plotW}" height="${barSize}" fill="${color}"><title>${esc(label(c))}: ${v}</title></rect>`)
        else out.push(`<rect data-cat="${esc(c.key)}" data-series="${esc(k)}" x="${left + offset}" y="${top + plotH - Math.max(frac, zero) * plotH}" width="${barSize}" height="${Math.abs(frac - zero) * plotH}" fill="${color}"><title>${esc(label(c))}: ${v}</title></rect>`)
      })
      const mid = (horizontal ? plotH : plotW) / n * (ci + 0.5)
      out.push(horizontal ? `<text x="${left - 6}" y="${top + mid + 4}" text-anchor="end" ${font} fill="#374151">${esc(label(c))}</text>` : `<text x="${left + mid}" y="${top + plotH + 18}" text-anchor="middle" ${font} fill="#374151">${esc(label(c))}</text>`)
    })
  } else {
    const n = Math.max(1, d.categories.length - 1)
    keys.forEach((k, ki) => {
      const pts = d.categories.map((c, ci) => `${(left + (ci / n) * plotW).toFixed(1)},${(top + plotH - ((val(c, k) - min) / span) * plotH).toFixed(1)}`)
      out.push(`<polyline fill="none" stroke="${PALETTE[ki % PALETTE.length]}" stroke-width="2" points="${pts.join(' ')}"/>`)
      d.categories.forEach((c, ci) => out.push(`<circle data-cat="${esc(c.key)}" data-series="${esc(k)}" cx="${(left + (ci / n) * plotW).toFixed(1)}" cy="${(top + plotH - ((val(c, k) - min) / span) * plotH).toFixed(1)}" r="5" fill="${PALETTE[ki % PALETTE.length]}"><title>${esc(label(c))}: ${val(c, k)}</title></circle>`))
    })
    d.categories.forEach((c, ci) => out.push(`<text x="${left + (ci / n) * plotW}" y="${top + plotH + 18}" text-anchor="middle" ${font} fill="#374151">${esc(label(c))}</text>`))
  }
  const axes = `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#9ca3af"/><line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#9ca3af"/>`
  const titles = (o.xTitle ? `<text x="${left + plotW / 2}" y="${H - 6}" text-anchor="middle" ${font} fill="#6b7280">${esc(o.xTitle)}</text>` : '') + (o.yTitle ? `<text x="12" y="${top + plotH / 2}" transform="rotate(-90 12 ${top + plotH / 2})" text-anchor="middle" ${font} fill="#6b7280">${esc(o.yTitle)}</text>` : '')
  return `${head}${axes}${out.join('')}${titles}</svg>`
}
