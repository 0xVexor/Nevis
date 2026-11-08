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
export type Measure =
  { kind: 'count' } | { kind: 'agg'; propertyId: Id; op: 'sum' | 'average' | 'median' | 'min' | 'max' | 'range' | 'count_values' | 'count_unique' | 'count_empty' | 'count_not_empty' }

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
    if (!['number', 'formula', 'checkbox'].includes(md.kind) && !['count_values', 'count_unique', 'count_empty', 'count_not_empty'].includes(req.measure.op))
      fail('INVALID_VALUE', 'measure: choose a Number property or a count')
  }
  const cat = req.categoryPropertyId ? checkAxis(state, req.categoryPropertyId, 'category') : null
  const ser = req.seriesPropertyId ? checkAxis(state, req.seriesPropertyId, 'series') : null
  if (req.type !== 'number' && !cat) fail('INVALID_VALUE', 'category: choose a property for the axis')
  const base: Partial<QueryRequest> = {
    filter: req.filter ?? null,
    search: req.search ?? '',
    limit: 500,
    weekStart: req.weekStart,
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
        const r = runQuery(
          state,
          makeQuery(state, req.sourceId, req.principalId, req.now, req.zone, {
            ...base,
            group: null,
            subgroup: null,
            filter: { kind: 'and', children: [...(req.filter ? [req.filter] : []), { kind: 'predicate', propertyId: c.datePropertyId, op: 'between', operand: range(k) as unknown as Json }] },
          }),
          rs,
        )
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
    if (g.sub)
      for (const s of g.sub) {
        seriesMap.set(s.key, s.key === NONE_GROUP ? '' : s.label)
        seriesValues[s.key] = measureOf(rs, state, req.measure, s.pageIds, req.zone)
      }
    return { key: g.key, label: g.label, total: measureOf(rs, state, req.measure, g.pageIds, req.zone), series: seriesValues }
  })
  if (req.order === 'value_desc') categories.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity))
  if (req.order === 'value_asc') categories.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity))
  let series = [...seriesMap].map(([key, label]) => ({ key, label }))
  let cats = categories
  if (cats.length > CHART_MAX_CATEGORIES) {
    warnings.push({ code: 'CATEGORIES_TRUNCATED', detail: `${cats.length - CHART_MAX_CATEGORIES} more categories are not shown` })
    cats = cats.slice(0, CHART_MAX_CATEGORIES)
  }
  if (series.length > CHART_MAX_SERIES) {
    warnings.push({ code: 'SERIES_TRUNCATED', detail: `${series.length - CHART_MAX_SERIES} more series are not shown` })
    series = series.slice(0, CHART_MAX_SERIES)
  }
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
      case 'select':
      case 'status':
        return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key })
      case 'multi_select':
      case 'people':
      case 'relation':
        return void parts.push({ kind: 'predicate', propertyId, op: 'contains', operand: key })
      case 'checkbox':
        return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key === 'true' })
      case 'date':
      case 'created_time':
      case 'last_edited_time': {
        const start = bucket === 'year' ? `${key}-01-01` : bucket === 'month' ? `${key}-01` : key
        const end = bucket === 'year' ? `${key}-12-31` : bucket === 'month' ? `${key}-31` : bucket === 'week' ? addWeek(key) : key
        return void parts.push({ kind: 'predicate', propertyId, op: 'between', operand: { start, end: bucket === 'month' ? lastOfMonth(key) : end } })
      }
      case 'number':
        return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: Number(key.replace(/^n:/, '')) })
      default:
        return void parts.push({ kind: 'predicate', propertyId, op: 'equals', operand: key.replace(/^t:/, '') })
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

// ───── SVG (on screen and for export; accessible, no external fonts) ─────

/**
 * Colours and type of a drawn chart. On screen the view resolves these from the design tokens (`--ds-chart-1…8`,
 * `--ds-raised`, `--ds-text…`, `--ds-line…`, `--ds-font-ui`), so a chart matches the theme and its export matches the screen.
 * The defaults are the light-mode values of those tokens, for tests and callers without a document.
 */
export type ChartTheme = { palette: string[]; surface: string; ink: string; muted: string; line: string; grid: string; font: string }
export const DEFAULT_CHART_THEME: ChartTheme = {
  palette: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  surface: '#ffffff',
  ink: '#222923',
  muted: '#58625b',
  line: '#c0ced1',
  grid: '#e4e7e2',
  font: 'system-ui, -apple-system, Segoe UI, Tahoma, sans-serif',
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const r1 = (n: number) => Math.round(n * 10) / 10
/** A bar with a 4px rounded end on its data side only; the baseline side stays square. */
function barPath(x: number, y: number, w: number, h: number, end: 'top' | 'bottom' | 'right' | 'left'): string {
  if (w <= 0 || h <= 0) return ''
  const r = Math.min(4, (end === 'top' || end === 'bottom' ? w : h) / 2, end === 'top' || end === 'bottom' ? h : w)
  const [X, Y, W, H] = [x, y, w, h].map(r1)
  if (end === 'top') return `M${X} ${Y + H}V${r1(Y + r)}Q${X} ${Y} ${r1(X + r)} ${Y}H${r1(X + W - r)}Q${r1(X + W)} ${Y} ${r1(X + W)} ${r1(Y + r)}V${r1(Y + H)}Z`
  if (end === 'bottom') return `M${X} ${Y}V${r1(Y + H - r)}Q${X} ${r1(Y + H)} ${r1(X + r)} ${r1(Y + H)}H${r1(X + W - r)}Q${r1(X + W)} ${r1(Y + H)} ${r1(X + W)} ${r1(Y + H - r)}V${Y}Z`
  if (end === 'right') return `M${X} ${Y}H${r1(X + W - r)}Q${r1(X + W)} ${Y} ${r1(X + W)} ${r1(Y + r)}V${r1(Y + H - r)}Q${r1(X + W)} ${r1(Y + H)} ${r1(X + W - r)} ${r1(Y + H)}H${X}Z`
  return `M${r1(X + W)} ${Y}H${r1(X + r)}Q${X} ${Y} ${X} ${r1(Y + r)}V${r1(Y + H - r)}Q${X} ${r1(Y + H)} ${r1(X + r)} ${r1(Y + H)}H${r1(X + W)}Z`
}
/** Round tick values for a value axis from min to max (about four steps). */
function ticks(min: number, max: number): number[] {
  const raw = (max - min) / 4 || 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100))

export function chartToSvg(
  d: ChartData,
  o: {
    title: string
    width?: number
    height?: number
    rtl?: boolean
    unassignedLabel?: string
    xTitle?: string
    yTitle?: string
    theme?: ChartTheme
    /** the colour an entity always has (a select or status option), so it looks the same here as in the table */
    colorOf?: (key: string) => string | undefined
  } = { title: '' },
): string {
  const W = o.width ?? 640
  const H = o.height ?? 360
  const th = o.theme ?? DEFAULT_CHART_THEME
  const font = `font-family="${esc(th.font)}" font-size="12"`
  const label = (c: { key: string; label: string }) => (c.key === NONE_GROUP ? (o.unassignedLabel ?? 'Unassigned') : c.label)
  // colour follows the entity, never its rank: fixed slot order, no cycling past the eighth (the rest share the muted ink)
  const slot = (i: number) => th.palette[i] ?? th.muted
  const colorFor = (key: string, i: number) => (key === NONE_GROUP ? th.muted : (o.colorOf?.(key) ?? slot(i)))
  const summary = d.type === 'number' ? `${o.title}: ${d.total ?? 'no value'}` : `${o.title}: ${d.categories.map((c) => `${label(c)} ${c.total ?? 0}`).join(', ')}`
  const head = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" direction="${o.rtl ? 'rtl' : 'ltr'}"><title id="t">${esc(o.title)}</title><desc id="d">${esc(summary)}</desc><rect width="${W}" height="${H}" fill="${th.surface}"/>`
  const text = (x: number, y: number, s: string, anchor: 'start' | 'middle' | 'end', fill = th.muted, extra = '') =>
    `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" ${font} fill="${fill}"${extra}>${esc(s)}</text>`
  /** an axis label cut to the room it has (about 6.5px a character at 12px), the full text kept as its tooltip */
  const axisLabel = (x: number, y: number, s: string, anchor: 'middle' | 'end', room: number) => {
    const max = Math.max(2, Math.floor(room / 6.5))
    if (s.length <= max) return text(x, y, s, anchor, th.ink)
    return `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" ${font} fill="${th.ink}"><title>${esc(s)}</title>${esc(s.slice(0, max - 1))}…</text>`
  }
  if (d.type === 'number')
    return `${head}<text x="${W / 2}" y="${H / 2 + 16}" text-anchor="middle" font-family="${esc(th.font)}" font-size="48" font-weight="600" fill="${th.ink}">${d.total ?? '–'}</text></svg>`

  // a legend whenever colour names something the axis does not: the donut's slices and every chart with series
  const legendItems =
    d.type === 'donut'
      ? d.categories.map((c, i) => ({ name: `${label(c)} · ${c.total ?? 0}`, color: colorFor(c.key, i) }))
      : d.series.length > 1
        ? d.series.map((s, i) => ({ name: s.label, color: colorFor(s.key, i) }))
        : []

  if (d.type === 'donut') {
    const sum = d.categories.reduce((a, c) => a + Math.max(0, c.total ?? 0), 0) || 1
    const legendW = Math.min(240, W * 0.4)
    const cx = (W - legendW) / 2
    const cy = H / 2
    const r = Math.min(W - legendW, H) / 2 - 24
    let a0 = -Math.PI / 2
    const arcs = d.categories.map((c, i) => {
      const frac = Math.max(0, c.total ?? 0) / sum
      const a1 = a0 + frac * Math.PI * 2
      const large = frac > 0.5 ? 1 : 0
      const p = (a: number, rr: number) => `${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`
      const path =
        frac >= 0.9999
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} L ${cx - 0.01} ${cy - r * 0.6} A ${r * 0.6} ${r * 0.6} 0 1 0 ${cx} ${cy - r * 0.6} Z`
          : `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, r * 0.6)} A ${r * 0.6} ${r * 0.6} 0 ${large} 0 ${p(a0, r * 0.6)} Z`
      a0 = a1
      // a 2px surface gap between slices
      return `<path data-cat="${esc(c.key)}" d="${path}" fill="${colorFor(c.key, i)}" stroke="${th.surface}" stroke-width="2" stroke-linejoin="round"><title>${esc(label(c))}: ${c.total ?? 0}</title></path>`
    })
    const lx = W - legendW + 8
    const ly = cy - (legendItems.length * 24) / 2 + 12
    const legend = legendItems
      .map(
        (it, i) =>
          `<g data-cat="${esc(d.categories[i].key)}"><rect x="${lx}" y="${r1(ly + i * 24 - 9)}" width="10" height="10" rx="2" fill="${it.color}"/>${text(lx + 18, ly + i * 24, it.name, 'start', th.ink)}</g>`,
      )
      .join('')
    return `${head}${arcs.join('')}${legend}</svg>`
  }

  const legendH = legendItems.length ? 28 : 0
  const left = 56
  const bottom = 48
  const top = 16 + legendH
  const plotW = W - left - 16
  const plotH = H - top - bottom
  const keys = d.series.length ? d.series.map((s) => s.key) : ['_']
  const val = (c: ChartData['categories'][number], k: string) => (k === '_' ? c.total : c.series[k]) ?? 0
  const all = d.categories.flatMap((c) => keys.map((k) => val(c, k)))
  const tk = ticks(Math.min(0, ...all), Math.max(1, ...all))
  const min = tk[0]
  const max = tk[tk.length - 1]
  const span = max - min || 1
  const out: string[] = []
  const horizontal = d.type === 'bar_horizontal'
  // recessive grid: hairlines at the ticks, the value beside each
  const grid = tk
    .map((v) => {
      const f = (v - min) / span
      return horizontal
        ? `<line x1="${r1(left + f * plotW)}" y1="${top}" x2="${r1(left + f * plotW)}" y2="${top + plotH}" stroke="${th.grid}"/>${text(left + f * plotW, top + plotH + 30, fmt(v), 'middle')}`
        : `<line x1="${left}" y1="${r1(top + plotH - f * plotH)}" x2="${left + plotW}" y2="${r1(top + plotH - f * plotH)}" stroke="${th.grid}"/>${text(left - 8, top + plotH - f * plotH + 4, fmt(v), 'end')}`
    })
    .join('')
  if (d.type === 'bar_vertical' || horizontal) {
    const n = d.categories.length || 1
    const zero = (0 - min) / span
    d.categories.forEach((c, ci) => {
      const bandSize = (horizontal ? plotH : plotW) / n
      const groupSize = Math.min(bandSize * 0.7, 48 * keys.length)
      const barSize = groupSize / keys.length
      keys.forEach((k, ki) => {
        const v = val(c, k)
        const frac = (v - min) / span
        const offset = ci * bandSize + (bandSize - groupSize) / 2 + ki * barSize
        const color = d.series.length ? colorFor(k, ki) : colorFor(c.key, ci)
        const gap = keys.length > 1 ? 2 : 0 // a 2px surface gap between neighbouring bars of a group
        const path = horizontal
          ? barPath(left + Math.min(frac, zero) * plotW, top + offset, Math.abs(frac - zero) * plotW, barSize - gap, v < 0 ? 'left' : 'right')
          : barPath(left + offset, top + plotH - Math.max(frac, zero) * plotH, barSize - gap, Math.abs(frac - zero) * plotH, v < 0 ? 'bottom' : 'top')
        if (path) out.push(`<path data-cat="${esc(c.key)}" data-series="${esc(k)}" d="${path}" fill="${color}"><title>${esc(label(c))}: ${v}</title></path>`)
      })
      const mid = bandSize * (ci + 0.5)
      out.push(horizontal ? axisLabel(left - 8, top + mid + 4, label(c), 'end', left - 12) : axisLabel(left + mid, top + plotH + 20, label(c), 'middle', bandSize - 4))
    })
  } else {
    const n = Math.max(1, d.categories.length - 1)
    keys.forEach((k, ki) => {
      const color = colorFor(k === '_' ? '' : k, ki)
      const pts = d.categories.map((c, ci) => `${(left + (ci / n) * plotW).toFixed(1)},${(top + plotH - ((val(c, k) - min) / span) * plotH).toFixed(1)}`)
      out.push(`<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>`)
      d.categories.forEach((c, ci) =>
        out.push(
          `<circle data-cat="${esc(c.key)}" data-series="${esc(k)}" cx="${(left + (ci / n) * plotW).toFixed(1)}" cy="${(top + plotH - ((val(c, k) - min) / span) * plotH).toFixed(1)}" r="4" fill="${color}" stroke="${th.surface}" stroke-width="2"><title>${esc(label(c))}: ${val(c, k)}</title></circle>`,
        ),
      )
    })
    // on a dense axis only every k-th label is written, so neighbours never run into each other
    const room = plotW / n
    const every = Math.max(1, Math.ceil(56 / Math.max(1, room)))
    d.categories.forEach((c, ci) => ci % every === 0 && out.push(axisLabel(left + (ci / n) * plotW, top + plotH + 20, label(c), 'middle', room * every - 4)))
  }
  const baseline = horizontal
    ? `<line x1="${r1(left + ((0 - min) / span) * plotW)}" y1="${top}" x2="${r1(left + ((0 - min) / span) * plotW)}" y2="${top + plotH}" stroke="${th.line}"/>`
    : `<line x1="${left}" y1="${r1(top + plotH - ((0 - min) / span) * plotH)}" x2="${left + plotW}" y2="${r1(top + plotH - ((0 - min) / span) * plotH)}" stroke="${th.line}"/>`
  let lx = left
  const legend = legendItems
    .map((it) => {
      const g = `<rect x="${r1(lx)}" y="${16 - 9}" width="10" height="10" rx="2" fill="${it.color}"/>${text(lx + 16, 16, it.name, 'start', th.ink)}`
      lx += 16 + it.name.length * 7 + 20
      return g
    })
    .join('')
  const titles =
    (o.xTitle ? text(left + plotW / 2, H - 6, o.xTitle, 'middle') : '') +
    (o.yTitle ? text(12, top + plotH / 2, o.yTitle, 'middle', th.muted, ` transform="rotate(-90 12 ${r1(top + plotH / 2)})"`) : '')
  return `${head}${legend}${grid}${baseline}${out.join('')}${titles}</svg>`
}
