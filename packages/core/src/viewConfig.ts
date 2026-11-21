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
export interface ViewConfig {
  v: number
  /** board: the select property whose options are the columns ('' = none) */
  groupBy: string
  sort: SortRule[]
  /** property ids not shown */
  hidden: string[]
}
export const DEFAULT_VIEW_CONFIG: ViewConfig = { v: VIEW_CONFIG_VERSION, groupBy: '', sort: [], hidden: [] }

const isObj = (x: unknown): x is Record<string, Json> => !!x && typeof x === 'object' && !Array.isArray(x)

export function readViewConfig(raw: Json | undefined, props: readonly PropertyModel[] = []): ViewConfig {
  if (!isObj(raw)) return { ...DEFAULT_VIEW_CONFIG, sort: [], hidden: [] }
  const live = new Map(props.filter(p => !p.trashed).map(p => [p.id, p]))
  const groupBy = typeof raw.groupBy === 'string' && live.get(raw.groupBy)?.type === 'select' ? raw.groupBy : ''
  const sort: SortRule[] = []
  if (Array.isArray(raw.sort)) for (const r of raw.sort) if (isObj(r) && typeof r.prop === 'string' && live.has(r.prop)) sort.push({ prop: r.prop, dir: r.dir === 'desc' ? 'desc' : 'asc' })
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((h): h is string => typeof h === 'string' && live.has(h)) : []
  return { v: typeof raw.v === 'number' ? raw.v : VIEW_CONFIG_VERSION, groupBy, sort, hidden }
}

/** The config to store after changing some fields: the fields this build does not know are kept as they were (a newer build wrote them). */
export function patchViewConfig(raw: Json | undefined, patch: Partial<Pick<ViewConfig, 'groupBy' | 'sort' | 'hidden'>>): Json {
  const base = isObj(raw) ? { ...raw } : {}
  const next: Record<string, Json> = { ...base, v: Math.max(VIEW_CONFIG_VERSION, typeof base.v === 'number' ? base.v : 0) }
  if (patch.groupBy !== undefined) next.groupBy = patch.groupBy
  if (patch.sort !== undefined) next.sort = patch.sort.map(s => ({ prop: s.prop, dir: s.dir }))
  if (patch.hidden !== undefined) next.hidden = [...patch.hidden]
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
export function viewRows(rows: readonly RowModel[], props: readonly PropertyModel[], config: ViewConfig): RowModel[] {
  const by = new Map(props.map(p => [p.id, p]))
  const out = rows.filter(r => !r.trashed)
  if (!config.sort.length) return out
  return out.sort((x, y) => {
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
