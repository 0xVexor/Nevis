// Value resolution: reduces any property of any row to a QValue (for filters / sort / group / aggregates) or a FormulaValue (for
// formulas), enforcing access on the way. Formula and rollup results are computed lazily with cycle + depth protection and are
// cached per (property, page, principal) for one state generation.
import type { Cell, Computed, Definition, FormulaValue, Id, Json, PageLike } from './model/types.ts'
import { Access } from './access.ts'
import { aggregateSafe } from './query/aggregate.ts'
import { EMPTY, type QValue } from './query/values.ts'
import { cellToText, defaultCell, isEmptyCell, optionName } from './props/registry.ts'
import { cfgOf, optionsOf, rollupConfig, type RollupAggregation } from './props/config.ts'
import { DbState, type Row } from './state.ts'
import { BUDGET, Blocked, FormulaError, type FormulaEnv } from './formula/runtime.ts'
import { evaluate } from './formula/eval.ts'
import { astFromJson, parse } from './formula/syntax.ts'
import { EMPTY_V, boolV, dateV, fromQValue, listV, numV, pageV, personV, runsV, textV, toQValue } from './formula/values.ts'
import type { Node } from './formula/syntax.ts'
import { matchKey, runsToText } from './text.ts'
import type { PropInfo, Schema } from './formula/compile.ts'

export type ResolverOptions = { principalId: Id; nowMs: number; zone: string; weekStart: number; clock?: () => number }

export const DEFAULT_WEEK_START = 6 // Saturday: Persian UI default (week start and weekend are workspace settings, independent of time zone)

/** Static type of a property for the formula compiler. */
export interface SchemaView {
  props(sourceId: Id): Definition[]
  relationOf(propertyId: Id): { propertyId: Id; targetSourceId: Id; sourceId: Id } | undefined
}

export function staticType(state: SchemaView, def: Definition): string {
  switch (def.kind) {
    case 'number': return 'number'
    case 'checkbox': return 'boolean'
    case 'date':
    case 'created_time':
    case 'last_edited_time': return 'date'
    case 'multi_select':
    case 'files': return 'list<text>'
    case 'people': return 'list<person>'
    case 'created_by':
    case 'last_edited_by': return 'person'
    case 'relation': {
      const rel = state.relationOf(def.id)
      if (!rel) return 'list<page>'
      const target = rel.propertyId === def.id ? rel.targetSourceId : rel.sourceId
      return `list<page@${target}>`
    }
    case 'rollup': return rollupResultType(def)
    case 'formula': {
      try {
        return cfgOf.formula(def).resultType
      } catch {
        return 'any'
      }
    }
    case 'button':
    case 'connected': return 'any'
    default: return 'text'
  }
}

export function rollupResultType(def: Definition): string {
  let cfg
  try {
    cfg = rollupConfig(def.config)
  } catch {
    return 'any'
  }
  switch (cfg.aggregation) {
    case 'earliest_date': case 'latest_date': case 'date_range': return 'date'
    case 'show_original': case 'show_unique': return 'list<any>'
    case 'min': case 'max': return 'number'
    default: return 'number'
  }
}

export function schemaFor(state: SchemaView, sourceId: Id, excludeId?: Id): Schema {
  const info = (d: Definition): PropInfo => ({ id: d.id, name: d.name, type: staticType(state, d) })
  return {
    props: state.props(sourceId).filter((d) => d.id !== excludeId && d.kind !== 'button').map(info),
    sourceProps: (sid) => state.props(sid).filter((d) => d.kind !== 'button').map(info),
  }
}

export const cellToQ = (_def: Definition, cell: Cell | undefined): QValue => {
  if (!cell) return EMPTY
  switch (cell.kind) {
    case 'text': {
      const t = runsToText(cell.runs)
      return t.length ? { c: 'text', text: t } : EMPTY
    }
    case 'number': return cell.value === null ? EMPTY : { c: 'number', n: cell.value }
    case 'select': return cell.optionId ? { c: 'members', ids: [cell.optionId], shape: 'select' } : EMPTY
    case 'multi_select': return cell.optionIds.length ? { c: 'members', ids: cell.optionIds, shape: 'multi_select' } : EMPTY
    case 'status': return cell.optionId ? { c: 'members', ids: [cell.optionId], shape: 'status' } : EMPTY
    case 'date': return cell.value ? { c: 'date', v: cell.value } : EMPTY
    case 'people': return cell.principalIds.length ? { c: 'members', ids: cell.principalIds, shape: 'people' } : EMPTY
    case 'files': return cell.attachmentIds.length ? { c: 'members', ids: cell.attachmentIds, shape: 'files' } : EMPTY
    case 'checkbox': return { c: 'bool', b: cell.value }
    case 'url': case 'email': case 'phone': return cell.value ? { c: 'text', text: cell.value } : EMPTY
    case 'place': return cell.value ? { c: 'text', text: [cell.value.name, cell.value.address].filter(Boolean).join(' ') } : EMPTY
    case 'verification': return { c: 'text', text: cell.value.state }
    case 'connected': return EMPTY // connected values are display-only: not filterable, sortable or readable by formulas
  }
}

const SHORT = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4)

/** Display text of an allocated unique ID token. */
export function formatUniqueId(def: Definition, token: string | undefined): string {
  if (!token) return ''
  const cfg = cfgOf.id(def)
  const i = token.lastIndexOf(':')
  const owner = i < 0 ? '' : token.slice(0, i)
  const n = i < 0 ? token : token.slice(i + 1)
  const mid = cfg.allocationMode === 'partitioned' && owner ? `${SHORT(owner)}-` : ''
  return `${cfg.prefix ? cfg.prefix + '-' : ''}${mid}${n}`
}

export type RelationTarget = { pageId: Id; state: 'live' | 'trashed' | 'pending' | 'restricted'; edgeId: Id }

export class Resolver {
  state: DbState
  access: Access
  opts: ResolverOptions
  private cache = new Map<string, Computed>()
  private stack: string[] = []
  private generation: number
  private asts = new Map<string, Node>()

  constructor(state: DbState, opts: ResolverOptions, access = new Access(state)) {
    this.state = state
    this.access = access
    this.opts = opts
    this.generation = state.generation
  }

  private fresh() {
    if (this.generation !== this.state.generation) {
      this.cache.clear()
      this.asts.clear()
      this.generation = this.state.generation
    }
  }

  get principalId() {
    return this.opts.principalId
  }

  /** Title a principal may see (never discloses an inaccessible row). */
  title(pageId: Id): string | undefined {
    const row = this.state.row(pageId)
    if (!row) return this.state.pages.get(pageId)?.title
    return this.access.canSeeRow(this.opts.principalId, row) ? row.page.title : undefined
  }

  // ───── QValue ─────

  value(row: Row, def: Definition): QValue {
    this.fresh()
    if (!this.access.canReadProperty(this.opts.principalId, def, row)) return { c: 'blocked', state: 'restricted' }
    switch (def.kind) {
      case 'title': return row.page.title.length ? { c: 'text', text: row.page.title } : EMPTY
      case 'created_time': return this.metaTime(row.page, 'created')
      case 'last_edited_time': return this.metaTime(row.page, 'updated')
      case 'created_by': return row.page.recordMeta?.createdBy ? { c: 'members', ids: [row.page.recordMeta.createdBy], shape: 'created_by' } : EMPTY
      case 'last_edited_by': return row.page.recordMeta?.updatedBy ? { c: 'members', ids: [row.page.recordMeta.updatedBy], shape: 'last_edited_by' } : EMPTY
      case 'unique_id': {
        const t = formatUniqueId(def, row.ext.allocatedIds[def.id])
        return t ? { c: 'text', text: t } : EMPTY
      }
      case 'relation': return this.relationValue(row, def)
      case 'formula':
      case 'rollup': return this.computedQ(row, def)
      case 'button':
      case 'connected': return EMPTY
      default: return cellToQ(def, row.ext.cells[def.id]?.value ?? defaultCell(def))
    }
  }

  private metaTime(page: PageLike, which: 'created' | 'updated'): QValue {
    const ms = which === 'created' ? (page.recordMeta?.createdAt ?? page.updatedAt) : page.updatedAt
    return ms ? { c: 'date', v: { kind: 'datetime', start: new Date(ms).toISOString(), end: null, timeZone: null } } : EMPTY
  }

  /** Targets of a relation property with their state, for editors that must show deleted / pending / restricted markers. */
  relationTargets(row: Row, def: Definition): RelationTarget[] {
    const rel = this.state.relationOf(def.id)
    if (!rel) return []
    const forward = rel.propertyId === def.id
    const edges = forward ? this.state.edgesOut(rel.id, row.page.id) : this.state.edgesIn(rel.id, row.page.id)
    return edges.map((e) => {
      const pid = forward ? e.toPageId : e.fromPageId
      const target = this.state.pages.get(pid)
      let st: RelationTarget['state']
      if (!target || !target.database) st = 'pending'
      else if (target.deletedAt !== null) st = 'trashed'
      else {
        const trow = this.state.row(pid)
        st = trow && this.access.canSeeRow(this.opts.principalId, trow) ? 'live' : 'restricted'
      }
      return { pageId: pid, state: st, edgeId: e.id }
    })
  }

  private relationValue(row: Row, def: Definition): QValue {
    const targets = this.relationTargets(row, def)
    if (targets.some((t) => t.state === 'restricted')) return { c: 'blocked', state: 'restricted' }
    const ids = targets.filter((t) => t.state === 'live').map((t) => t.pageId)
    return ids.length ? { c: 'members', ids, shape: 'relation' } : EMPTY
  }

  // ───── formula / rollup ─────

  computed(row: Row, def: Definition): Computed {
    this.fresh()
    const key = `${def.id}|${row.page.id}|${this.opts.principalId}`
    const hit = this.cache.get(key)
    if (hit) return hit
    if (this.stack.includes(key)) return { state: 'error', code: 'CYCLE', detail: 'a formula or rollup depends on itself' }
    if (this.stack.length >= BUDGET.maxRefDepth) return { state: 'error', code: 'FORMULA_DEPTH', detail: `more than ${BUDGET.maxRefDepth} chained formula/rollup references` }
    this.stack.push(key)
    let out: Computed
    try {
      out = def.kind === 'formula' ? this.runFormula(row, def) : this.runRollup(row, def)
    } catch (e) {
      out = { state: 'error', code: 'SCHEMA_MISMATCH', detail: e instanceof Error ? e.message : String(e) }
    } finally {
      this.stack.pop()
    }
    this.cache.set(key, out)
    return out
  }

  private computedQ(row: Row, def: Definition): QValue {
    const c = this.computed(row, def)
    if (c.state === 'ready') return toQValue(c.value)
    if (c.state === 'error') return { c: 'blocked', state: 'error', code: c.code, detail: c.detail }
    return { c: 'blocked', state: c.state }
  }

  private runFormula(row: Row, def: Definition): Computed {
    const cfg = cfgOf.formula(def)
    const key = `${def.id}:${def.revision}`
    let ast = this.asts.get(key)
    if (!ast) {
      ast = cfg.ast ? astFromJson(cfg.ast) : parse(cfg.source)
      this.asts.set(key, ast)
    }
    const env = this.formulaEnv(row)
    const r = evaluate(ast, env)
    if (r.state === 'ready') return { state: 'ready', value: r.value }
    if (r.state === 'error') return { state: 'error', code: r.diagnostics[0]?.code ?? 'FORMULA_TYPE', detail: r.diagnostics[0]?.message ?? '' }
    return { state: r.state }
  }

  formulaEnv(row: Row): FormulaEnv {
    const o = this.opts
    return {
      vaultId: this.state.vaultId,
      nowMs: o.nowMs,
      zone: o.zone,
      currentPageId: row.page.id,
      clock: o.clock,
      getProp: (pageId, propertyId) => {
        const r = this.state.row(pageId)
        const d = this.state.prop(propertyId)
        if (!r || !d) throw new Blocked('pending') // target not arrived yet (or property restored later): pending, not empty
        return this.formulaValue(r, d)
      },
      findProp: (pageId, name) => {
        const r = this.state.row(pageId)
        if (!r) return undefined
        const k = matchKey(name).trim()
        return this.state.props(r.sourceId).find((d) => matchKey(d.name).trim() === k)?.id
      },
      pageTitle: (id) => this.title(id),
      person: (id) => {
        const p = this.access.principal(id)
        return p ? { name: p.displayName, email: p.email } : undefined
      },
    }
  }

  private runRollup(row: Row, def: Definition): Computed {
    const cfg = rollupConfig(def.config)
    const relProp = this.state.prop(cfg.relationPropertyId)
    if (!relProp || relProp.kind !== 'relation' || relProp.sourceId !== def.sourceId) return { state: 'error', code: 'SCHEMA_MISMATCH', detail: 'rollup relation property is missing' }
    const rel = this.state.relationOf(relProp.id)
    if (!rel) return { state: 'error', code: 'SCHEMA_MISMATCH', detail: 'rollup relation is missing' }
    const forward = rel.propertyId === relProp.id
    const targetSource = forward ? rel.targetSourceId : rel.sourceId
    const target = this.state.prop(cfg.targetPropertyId)
    if (!target || target.sourceId !== targetSource) return { state: 'error', code: 'SCHEMA_MISMATCH', detail: 'rollup target property is missing' }
    if (target.kind === 'rollup') return { state: 'error', code: 'SCHEMA_MISMATCH', detail: 'a rollup cannot read another rollup directly' }
    if (!this.access.canReadProperty(this.opts.principalId, relProp, row)) return { state: 'restricted' }
    const targets = this.relationTargets(row, relProp)
    if (targets.some((t) => t.state === 'pending')) return { state: 'pending' }
    if (targets.some((t) => t.state === 'restricted')) return { state: 'restricted' }
    const rows = targets.filter((t) => t.state === 'live').map((t) => this.state.row(t.pageId)!)
    const seen = new Set<Id>()
    const distinct = rows.filter((r) => (seen.has(r.page.id) ? false : (seen.add(r.page.id), true)))
    if (distinct.length && !this.access.canReadProperty(this.opts.principalId, target, distinct[0])) return { state: 'restricted' }
    const values = distinct.map((r) => this.value(r, target))
    const q = aggregateSafe(cfg.aggregation as RollupAggregation, { values, zone: this.opts.zone })
    if (q.c === 'blocked') return q.state === 'error' ? { state: 'error', code: q.code ?? 'INVALID_VALUE', detail: q.detail ?? '' } : { state: q.state }
    return { state: 'ready', value: fromQValue(q, this.state.vaultId) }
  }

  // ───── FormulaValue ─────

  /** Value of a property as seen by a formula. Throws Blocked for restricted / pending input. */
  formulaValue(row: Row, def: Definition): FormulaValue {
    this.fresh()
    if (!this.access.canReadProperty(this.opts.principalId, def, row)) throw new Blocked('restricted')
    switch (def.kind) {
      case 'title': return textV(row.page.title)
      case 'formula':
      case 'rollup': {
        const c = this.computed(row, def)
        if (c.state === 'ready') return c.value
        if (c.state === 'error') throw new FormulaPropagated(c.code, c.detail)
        throw new Blocked(c.state)
      }
      case 'relation': {
        const targets = this.relationTargets(row, def)
        if (targets.some((t) => t.state === 'restricted')) throw new Blocked('restricted')
        if (targets.some((t) => t.state === 'pending')) throw new Blocked('pending')
        return listV(targets.filter((t) => t.state === 'live').map((t) => pageV(t.pageId, this.state.vaultId)))
      }
      case 'created_time': case 'last_edited_time': {
        const q = this.value(row, def)
        return q.c === 'date' ? dateV(q.v) : EMPTY_V
      }
      case 'created_by': case 'last_edited_by': {
        const q = this.value(row, def)
        return q.c === 'members' && q.ids[0] ? personV(q.ids[0]) : EMPTY_V
      }
      case 'unique_id': return textV(formatUniqueId(def, row.ext.allocatedIds[def.id]))
      case 'button': case 'connected': return EMPTY_V
      default: return cellToFormula(def, row.ext.cells[def.id]?.value ?? defaultCell(def))
    }
  }

  /** Plain-text projections of a row's searchable properties (title + properties; never the body). */
  searchProjection(row: Row, defs: Definition[]): string[] {
    const out: string[] = []
    for (const def of defs) {
      if (!this.access.canReadProperty(this.opts.principalId, def, row)) continue
      if (def.kind === 'button' || def.kind === 'files' || def.kind === 'connected') continue
      if (def.kind === 'title') { out.push(matchKey(row.page.title)); continue }
      if (def.kind === 'relation') {
        for (const t of this.relationTargets(row, def)) if (t.state === 'live') out.push(matchKey(this.title(t.pageId) ?? ''))
        continue
      }
      if (def.kind === 'people') {
        const c = row.ext.cells[def.id]?.value
        if (c?.kind === 'people') for (const p of c.principalIds) out.push(matchKey(this.access.principal(p)?.displayName ?? ''))
        continue
      }
      if (def.kind === 'formula' || def.kind === 'rollup') {
        const q = this.computedQ(row, def)
        if (q.c === 'text') out.push(matchKey(q.text))
        else if (q.c === 'number') out.push(String(q.n))
        continue
      }
      if (def.kind === 'created_time' || def.kind === 'last_edited_time' || def.kind === 'created_by' || def.kind === 'last_edited_by' || def.kind === 'date') continue
      if (def.kind === 'unique_id') { out.push(matchKey(formatUniqueId(def, row.ext.allocatedIds[def.id]))); continue }
      const cell = row.ext.cells[def.id]?.value ?? defaultCell(def)
      if (cell && !isEmptyCell(cell)) out.push(matchKey(cellToText(def, cell)))
    }
    return out.filter(Boolean)
  }
}

/** A referenced formula already failed: its error code travels on. */
export class FormulaPropagated extends FormulaError {
  propagated = true
  constructor(code: string, detail: string) {
    super(code, detail, 0, 0)
  }
}

export function cellToFormula(def: Definition, cell: Cell | undefined): FormulaValue {
  if (!cell) return def.kind === 'checkbox' ? boolV(false) : def.kind === 'multi_select' || def.kind === 'people' || def.kind === 'files' ? listV([]) : EMPTY_V
  switch (cell.kind) {
    case 'text': return cell.runs.length ? runsV(cell.runs) : textV('')
    case 'number': return cell.value === null ? EMPTY_V : numV(cell.value)
    case 'select': return cell.optionId ? textV(optionName(def, cell.optionId)) : EMPTY_V
    case 'status': return textV(optionName(def, cell.optionId))
    case 'multi_select': return listV(cell.optionIds.map((i) => textV(optionName(def, i))))
    case 'date': return cell.value ? dateV(cell.value) : EMPTY_V
    case 'people': return listV(cell.principalIds.map(personV))
    case 'files': return listV(cell.attachmentIds.map(textV))
    case 'checkbox': return boolV(cell.value)
    case 'url': case 'email': case 'phone': return cell.value ? textV(cell.value) : EMPTY_V
    case 'place': return cell.value ? textV(cell.value.name || cell.value.address) : EMPTY_V
    case 'verification': return textV(cell.value.state)
    case 'connected': return EMPTY_V
  }
}

export function optionRank(def: Definition, id: Id): number {
  const i = optionsOf(def).findIndex((o) => o.id === id)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

export const asJson = (v: unknown): Json => v as Json
