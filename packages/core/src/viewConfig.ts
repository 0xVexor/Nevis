// The shape of `view.config` (a whole-value JSON register, ADR-0004) and how a view turns rows into what is shown. Format: docs/formats/records-v1.md.
//
// VERSIONED and TOLERANT: `config` is written by many devices and older/newer builds, so reading never throws and never trusts: a missing
// or wrong field falls back to its default, unknown fields are ignored (and kept when the config is rewritten by `patchViewConfig`), a
// `groupBy` that names a property that is gone or is not a select means "no grouping". A newer `v` is read as far as it is understood.
import type { Json } from '@nevis/protocol'
import { compareDecimal } from './decimal'
import type { CellValue, PropertyModel, RowModel } from './records'

export const VIEW_CONFIG_VERSION = 1
export interface SortRule { prop: string; dir: 'asc' | 'desc' }
/** One condition of a view's filter; all of a view's rules must hold. `value` is the text typed (a number, a date, or an option id for select). */
export type FilterOp = 'contains' | 'not_contains' | 'is' | 'is_not' | 'gt' | 'lt' | 'empty' | 'not_empty' | 'checked' | 'unchecked'
export interface FilterRule { prop: string; op: FilterOp; value: string }
const FILTER_OPS: readonly string[] = ['contains', 'not_contains', 'is', 'is_not', 'gt', 'lt', 'empty', 'not_empty', 'checked', 'unchecked']
export interface ViewConfig {
  v: number
  /** board: the select property whose options are the columns ('' = none) */
  groupBy: string
  sort: SortRule[]
  /** property ids not shown */
  hidden: string[]
  /** conditions a row must meet to be shown (all of them) */
  filter: FilterRule[]
}
export const DEFAULT_VIEW_CONFIG: ViewConfig = { v: VIEW_CONFIG_VERSION, groupBy: '', sort: [], hidden: [], filter: [] }

const isObj = (x: unknown): x is Record<string, Json> => !!x && typeof x === 'object' && !Array.isArray(x)

export function readViewConfig(raw: Json | undefined, props: readonly PropertyModel[] = []): ViewConfig {
  if (!isObj(raw)) return { ...DEFAULT_VIEW_CONFIG, sort: [], hidden: [], filter: [] }
  const live = new Map(props.filter(p => !p.trashed).map(p => [p.id, p]))
  const groupBy = typeof raw.groupBy === 'string' && live.get(raw.groupBy)?.type === 'select' ? raw.groupBy : ''
  const sort: SortRule[] = []
  if (Array.isArray(raw.sort)) for (const r of raw.sort) if (isObj(r) && typeof r.prop === 'string' && live.has(r.prop)) sort.push({ prop: r.prop, dir: r.dir === 'desc' ? 'desc' : 'asc' })
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((h): h is string => typeof h === 'string' && live.has(h)) : []
  const filter: FilterRule[] = []
  if (Array.isArray(raw.filter)) for (const r of raw.filter) if (isObj(r) && typeof r.prop === 'string' && live.has(r.prop) && typeof r.op === 'string' && FILTER_OPS.includes(r.op)) filter.push({ prop: r.prop, op: r.op as FilterOp, value: typeof r.value === 'string' ? r.value : '' })
  return { v: typeof raw.v === 'number' ? raw.v : VIEW_CONFIG_VERSION, groupBy, sort, hidden, filter }
}

/** The config to store after changing some fields: the fields this build does not know are kept as they were (a newer build wrote them). */
export function patchViewConfig(raw: Json | undefined, patch: Partial<Pick<ViewConfig, 'groupBy' | 'sort' | 'hidden' | 'filter'>>): Json {
  const base = isObj(raw) ? { ...raw } : {}
  const next: Record<string, Json> = { ...base, v: Math.max(VIEW_CONFIG_VERSION, typeof base.v === 'number' ? base.v : 0) }
  if (patch.groupBy !== undefined) next.groupBy = patch.groupBy
  if (patch.sort !== undefined) next.sort = patch.sort.map(s => ({ prop: s.prop, dir: s.dir }))
  if (patch.hidden !== undefined) next.hidden = [...patch.hidden]
  if (patch.filter !== undefined) next.filter = patch.filter.map(f => ({ prop: f.prop, op: f.op, value: f.value }))
  return next
}

const text = (v: CellValue | undefined): string => (typeof v === 'string' ? v : '')

/** Compares two NON-EMPTY cells of one property for sorting: numbers exactly (decimal strings), dates and text as strings, checkboxes false < true, selects by option order. */
const isEmpty = (v: CellValue | undefined) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
function compareCells(p: PropertyModel, a: CellValue | undefined, b: CellValue | undefined): number {
  switch (p.type) {
    case 'number': return compareDecimal(text(a), text(b))
    case 'checkbox': return Number(a === true) - Number(b === true)
    case 'select': { const rank = (v: CellValue | undefined) => { const i = p.options.findIndex(o => o.id === v); return i < 0 ? 1e9 : i }; return rank(a) - rank(b) }
    case 'multiSelect':
    case 'relation': return (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0)
    default: return text(a).localeCompare(text(b), 'fa')
  }
}

/** Rows in the order of the view: its sort rules, then the rows' own order (sortKey, id) so equal rows keep a stable place. Trashed rows are left out. */
/** Does a row meet one condition? A rule that names a property that is gone never reaches here (it is dropped when the config is read). */
export function matchRule(p: PropertyModel, v: CellValue | undefined, rule: FilterRule): boolean {
  const empty = isEmpty(v)
  const q = rule.value.trim()
  switch (rule.op) {
    case 'empty': return empty
    case 'not_empty': return !empty
    case 'checked': return v === true
    case 'unchecked': return v !== true
    case 'gt': return !empty && p.type === 'number' && compareDecimal(text(v), q) > 0
    case 'lt': return !empty && p.type === 'number' && compareDecimal(text(v), q) < 0
    case 'is': case 'is_not': {
      const has = p.type === 'select' ? v === q : Array.isArray(v) ? v.includes(q) : p.type === 'number' ? !empty && compareDecimal(text(v), q) === 0 : text(v).trim() === q
      return rule.op === 'is' ? has : !has
    }
    case 'contains': case 'not_contains': {
      const has = Array.isArray(v) ? v.includes(q) : text(v).toLowerCase().includes(q.toLowerCase())
      return rule.op === 'contains' ? has : !has
    }
  }
}

export function viewRows(rows: readonly RowModel[], props: readonly PropertyModel[], config: ViewConfig): RowModel[] {
  const by = new Map(props.map(p => [p.id, p]))
  let out = rows.filter(r => !r.trashed)
  for (const rule of config.filter ?? []) { const p = by.get(rule.prop); if (p) out = out.filter(r => matchRule(p, r.cells[p.id], rule)) }
  if (!config.sort.length) return out
  return [...out].sort((x, y) => {
    for (const s of config.sort) {
      const p = by.get(s.prop)
      if (!p) continue
      const [a, b] = [x.cells[p.id], y.cells[p.id]]
      if (isEmpty(a) || isEmpty(b)) { if (isEmpty(a) !== isEmpty(b)) return isEmpty(a) ? 1 : -1; continue } // empty is LAST in both directions
      const c = compareCells(p, a, b)
      if (c !== 0) return s.dir === 'desc' ? -c : c
    }
    return 0
  })
}

export interface BoardColumn { id: string; name: string; color: string; rows: RowModel[] }
/** The columns of a board: one per option of the group-by property (in option order) and a "no value" column for rows whose option is empty or removed. */
export function boardColumns(rows: readonly RowModel[], props: readonly PropertyModel[], config: ViewConfig): BoardColumn[] {
  const p = props.find(x => x.id === config.groupBy && !x.trashed && x.type === 'select')
  const ordered = viewRows(rows, props, { ...config, sort: config.sort })
  if (!p) return [{ id: '', name: '', color: '', rows: ordered }]
  const cols: BoardColumn[] = [{ id: '', name: '', color: '', rows: [] }, ...p.options.map(o => ({ id: o.id, name: o.name, color: o.color, rows: [] as RowModel[] }))]
  const index = new Map(cols.map(c => [c.id, c]))
  for (const r of ordered) { const v = r.cells[p.id]; (index.get(typeof v === 'string' && index.has(v) ? v : '') ?? cols[0]!).rows.push(r) }
  return cols
}
