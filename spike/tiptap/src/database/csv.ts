// CSV / Markdown interchange (handoff §27). CSV is a readable exchange format, never a lossless backup: it cannot carry schemas,
// formulas or permissions. Import appends rows (explicit upsert is a labeled extension); export honours scope and permissions
// and guards cells that a spreadsheet would execute.
import type { Cell, Definition, Id, Json, QueryPage } from './model/types.ts'
import { DbError, fail } from './model/errors.ts'
import { startsLikeFormula, matchKey, runsToText } from './text.ts'
import { DESCRIPTORS, cellToText, parseCellText, defaultCell, type ParseCtx } from './props/registry.ts'
import { optionsOf } from './props/config.ts'
import { Resolver, formatUniqueId } from './resolver.ts'
import { runQuery, makeQuery, MAX_LIMIT, type QueryRequest } from './query/engine.ts'
import type { DbState } from './state.ts'

// ───── parsing / writing ─────

/** RFC-4180 style: quoted fields, doubled quotes, embedded delimiters and newlines, optional BOM. */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endField = () => (row.push(field), (field = ''))
  const endRow = () => (endField(), rows.push(row), (row = []))
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && field === '') { quoted = true; i++; continue }
    if (c === delimiter) { endField(); i++; continue }
    if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); i++; continue }
    if (c === '\n') { endRow(); i++; continue }
    field += c; i++
  }
  if (quoted) fail('INVALID_VALUE', 'the CSV file ends inside a quoted field')
  if (field !== '' || row.length) endRow()
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

export function writeCsv(rows: string[][], opts: { delimiter?: string; safe?: boolean; bom?: boolean } = {}): string {
  const d = opts.delimiter ?? ','
  const safe = opts.safe !== false
  const esc = (v: string) => {
    let s = v
    // spreadsheet formula injection: =, +, -, @ at the start would execute; prefix with an apostrophe in safe mode
    if (safe && startsLikeFormula(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) || s.includes(d) || s.startsWith(' ') || s.endsWith(' ') ? `"${s.replace(/"/g, '""')}"` : s
  }
  return (opts.bom ? '﻿' : '') + rows.map((r) => r.map(esc).join(d)).join('\r\n') + '\r\n'
}

// ───── export ─────

export type ExportOptions = {
  sourceId: Id
  principalId: Id
  propertyIds?: Id[]
  query?: Partial<QueryRequest>
  now: string
  zone: string
  includeIds?: boolean
  safe?: boolean
}

function displayCell(state: DbState, rs: Resolver, def: Definition, pageId: Id): string {
  const row = state.row(pageId)!
  if (!rs.access.canReadProperty(rs.principalId, def, row)) return ''
  switch (def.kind) {
    case 'title': return row.page.title
    case 'relation': return rs.relationTargets(row, def).filter((t) => t.state === 'live').map((t) => rs.title(t.pageId) ?? '').join(', ')
    case 'unique_id': return formatUniqueId(def, row.ext.allocatedIds[def.id])
    case 'formula':
    case 'rollup': {
      const q = rs.value(row, def)
      if (q.c === 'blocked') return ''
      if (q.c === 'number') return String(q.n)
      if (q.c === 'text') return q.text
      if (q.c === 'bool') return String(q.b)
      if (q.c === 'date') return q.v.end ? `${q.v.start} → ${q.v.end}` : q.v.start
      if (q.c === 'members') return q.ids.map((i) => rs.title(i) ?? rs.access.principal(i)?.displayName ?? i).join(', ')
      if (q.c === 'list') return q.items.map((x) => (x.c === 'text' ? x.text : x.c === 'number' ? String(x.n) : '')).join(', ')
      return ''
    }
    case 'created_time': case 'last_edited_time': { const q = rs.value(row, def); return q.c === 'date' ? q.v.start : '' }
    case 'created_by': case 'last_edited_by': { const q = rs.value(row, def); return q.c === 'members' ? (rs.access.principal(q.ids[0])?.displayName ?? q.ids[0]) : '' }
    case 'button': case 'connected': return ''
    default: return cellToText(def, row.ext.cells[def.id]?.value ?? defaultCell(def), { personName: (id) => rs.access.principal(id)?.displayName ?? id })
  }
}

export function exportTable(state: DbState, o: ExportOptions): { header: string[]; rows: string[][]; ids: Id[] } {
  const rs = new Resolver(state, { principalId: o.principalId, nowMs: Date.parse(o.now), zone: o.zone, weekStart: 6 })
  const defs = (o.propertyIds ? o.propertyIds.map((id) => state.prop(id)).filter((d): d is Definition => !!d) : state.props(o.sourceId)).filter((d) => d.kind !== 'button' && rs.access.canReadProperty(o.principalId, d))
  const header = defs.map((d) => d.name)
  const rows: string[][] = []
  const ids: Id[] = []
  let cursor: string | undefined
  do {
    const page: QueryPage = runQuery(state, makeQuery(state, o.sourceId, o.principalId, o.now, o.zone, { ...(o.query ?? {}), limit: MAX_LIMIT, cursor }), rs)
    for (const id of page.pageIds) { rows.push([...(o.includeIds ? [id] : []), ...defs.map((d) => displayCell(state, rs, d, id))]); ids.push(id) }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { header: o.includeIds ? ['id', ...header] : header, rows, ids }
}

export function exportCsv(state: DbState, o: ExportOptions): string {
  const t = exportTable(state, o)
  return writeCsv([t.header, ...t.rows], { safe: o.safe, bom: true })
}

export function exportMarkdown(state: DbState, o: ExportOptions): string {
  const t = exportTable(state, o)
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  return [`| ${t.header.map(esc).join(' | ')} |`, `| ${t.header.map(() => '---').join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') + '\n'
}

// ───── import ─────

export type ColumnMap = { column: number; target: Id | 'title' | 'page_id' | 'skip' }
export type ImportOptions = {
  sourceId: Id
  sessionId: Id
  hasHeader: boolean
  columns: ColumnMap[]
  decimalSeparator?: string
  listDelimiter?: string
  zone?: string
  /** label -> page id per relation property; titles never resolve implicitly */
  relationLabels?: Record<Id, Record<string, Id>>
  /** create missing select options (needs schema permission) */
  createOptions?: boolean
  /** import values that cannot be parsed as empty and report them, instead of rejecting the whole file */
  skipInvalid?: boolean
  upsertBy?: 'page_id' | null
}

export type ImportProblem = { row: number; column: number; propertyId: Id | null; message: string }
export type ImportRow = { pageId?: Id; title: string; cells: Record<Id, Cell | null>; relations: Record<Id, Id[]> }
export type ImportPlan = { rows: ImportRow[]; problems: ImportProblem[]; newOptions: Record<Id, string[]>; inferred: { column: number; kind: string }[] }

/** Guess a type per column for the preview UI. Never applied without the user accepting it. */
export function inferColumnKinds(rows: string[][], columns: number): { column: number; kind: 'number' | 'checkbox' | 'date' | 'text' }[] {
  return Array.from({ length: columns }, (_, column) => {
    const vals = rows.map((r) => (r[column] ?? '').trim()).filter(Boolean)
    if (!vals.length) return { column, kind: 'text' as const }
    if (vals.every((v) => /^-?\d+([.,]\d+)?$/.test(v))) return { column, kind: 'number' as const }
    if (vals.every((v) => /^(true|false|yes|no)$/i.test(v))) return { column, kind: 'checkbox' as const }
    if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) return { column, kind: 'date' as const }
    return { column, kind: 'text' as const }
  })
}

/** What the import planner needs to read: a DbState, or a Draft through a small adapter. */
export interface ImportWorld {
  props(sourceId: Id): Definition[]
  row(pageId: Id): { page: { title: string } } | undefined
  relationOf(propertyId: Id): { propertyId: Id; targetSourceId: Id; sourceId: Id } | undefined
  titlesIn(sourceId: Id): { id: Id; title: string }[]
}

export const worldOf = (state: DbState): ImportWorld => ({
  props: (s) => state.props(s), row: (id) => state.row(id), relationOf: (id) => state.relationOf(id),
  titlesIn: (s) => state.rows(s).map((r) => ({ id: r.page.id, title: r.page.title })),
})

export function planImport(state: ImportWorld, data: string[][], o: ImportOptions): ImportPlan {
  const body = o.hasHeader ? data.slice(1) : data
  const problems: ImportProblem[] = []
  const rows: ImportRow[] = []
  const newOptions: Record<Id, string[]> = {}
  const defs = new Map(state.props(o.sourceId).map((d) => [d.id, d]))
  for (const c of o.columns) {
    if (c.target === 'skip' || c.target === 'title' || c.target === 'page_id') continue
    const d = defs.get(c.target)
    if (!d) fail('SCHEMA_MISMATCH', 'a column maps to a property that is not in this source')
    if (d!.kind === 'formula' || d!.kind === 'rollup' || d!.kind === 'button' || d!.kind === 'connected')
      fail('UNSUPPORTED_CONVERSION', `${d!.kind} definitions are never executed from a CSV cell; use a native bundle`)
  }
  const pctx: ParseCtx = { decimalSeparator: o.decimalSeparator, listDelimiter: o.listDelimiter, zone: o.zone ?? 'UTC' }
  body.forEach((r, ri) => {
    const row: ImportRow = { title: '', cells: {}, relations: {} }
    for (const c of o.columns) {
      const raw = (r[c.column] ?? '').toString()
      if (c.target === 'skip') continue
      if (c.target === 'title') { row.title = raw; continue }
      if (c.target === 'page_id') { if (raw.trim()) row.pageId = raw.trim(); continue }
      const d = defs.get(c.target)!
      const at = (message: string) => problems.push({ row: ri + (o.hasHeader ? 2 : 1), column: c.column, propertyId: d.id, message })
      try {
        if (d.kind === 'relation') {
          const labels = raw.split(o.listDelimiter ?? '\u0000').map((s) => s.trim()).filter(Boolean)
          const ids: Id[] = []
          for (const l of o.listDelimiter ? labels : raw.trim() ? [raw.trim()] : []) {
            if (state.row(l)) { ids.push(l); continue } // ids first
            const mapped = o.relationLabels?.[d.id]?.[l]
            if (mapped) { ids.push(mapped); continue }
            const rel = state.relationOf(d.id)
            const target = rel ? (rel.propertyId === d.id ? rel.targetSourceId : rel.sourceId) : null
            const same = target ? state.titlesIn(target).filter((x) => matchKey(x.title) === matchKey(l)) : []
            at(same.length > 1 ? `"${l}" matches ${same.length} items; choose one` : `"${l}" is not mapped to an item`)
          }
          row.relations[d.id] = ids
        } else if (!raw.trim() && d.kind !== 'text') row.cells[d.id] = null
        else {
          row.cells[d.id] = DESCRIPTORS[d.kind].writable ? parseCellText(d, raw, pctx) : null
        }
      } catch (e) {
        at(e instanceof DbError ? e.message : String(e))
        if (o.skipInvalid) row.cells[d.id] = null
      }
    }
    rows.push(row)
  })
  return { rows, problems, newOptions, inferred: inferColumnKinds(body, Math.max(0, ...data.map((r) => r.length))) }
}

export const rowToJson = (r: ImportRow): Json => r as unknown as Json
export { runsToText }

/** Option labels in select-like columns that do not exist yet (created first, with schema permission, when the user allows it). */
export function collectNewOptions(world: ImportWorld, data: string[][], o: ImportOptions): Record<Id, string[]> {
  const out: Record<Id, string[]> = {}
  const body = o.hasHeader ? data.slice(1) : data
  const defs = new Map(world.props(o.sourceId).map((d) => [d.id, d]))
  for (const c of o.columns) {
    const d = typeof c.target === 'string' ? defs.get(c.target) : undefined
    if (!d || !['select', 'multi_select', 'status'].includes(d.kind)) continue
    for (const r of body) {
      const raw = (r[c.column] ?? '').trim()
      const labels = d.kind === 'multi_select' && o.listDelimiter ? raw.split(o.listDelimiter).map((x) => x.trim()) : [raw]
      for (const l of labels) {
        if (!l || optionsOf(d).some((x) => matchKey(x.name).trim() === matchKey(l))) continue
        const list = (out[d.id] ??= [])
        if (!list.some((x) => matchKey(x) === matchKey(l))) list.push(l)
      }
    }
  }
  return out
}
