// One query per view render pass: the saved view filter / sorts plus the viewer's own unsaved overrides and search.
import { useMemo } from 'react'
import type { Filter, GroupSpec, Id, Sort, View } from '../model/types.ts'
import { isDbError } from '../model/errors.ts'
import { MAX_LIMIT, type QueryRequest, type QueryResult, type QueryRow } from '../query/engine.ts'
import type { RollupAggregation } from '../props/config.ts'
import type { DatabaseService } from '../service.ts'
import { effectiveFilter } from '../viewLogic.ts'

export type Personal = { filter?: Filter | null; sorts?: Sort[] | null }
export type ViewQueryOpts = {
  search?: string
  personal?: Personal | null
  /** how many rows to load; more is fetched in pages of 500 */
  want?: number
  group?: GroupSpec | null
  subgroup?: GroupSpec | null
  totals?: Record<Id, RollupAggregation>
  extraFilter?: Filter | null
  subItems?: QueryRequest['subItems']
  manualOrder?: Id[]
  /** dashboard: a global filter mapped onto this widget's source */
  global?: { predicate: { op: string; operand?: never } | null; mappings: Record<Id, Id> } | null
}

export type ViewQueryResult = {
  rows: QueryRow[]
  total: number
  groups: QueryResult['groups']
  totals: QueryResult['totals']
  hasMore: boolean
  error: { code: string; message: string } | null
  matchIds: Id[]
  filter: Filter | null
  sorts: Sort[]
  affected: boolean
}

export const EMPTY_RESULT: ViewQueryResult = { rows: [], total: 0, groups: [], totals: {}, hasMore: false, error: null, matchIds: [], filter: null, sorts: [], affected: true }

/** Runs the view's query synchronously (in-memory index) and re-runs after every committed change. */
export function useViewQuery(svc: DatabaseService, view: View, o: ViewQueryOpts = {}): ViewQueryResult {
  const version = svc.getVersion()
  return useMemo(() => {
    if (!view.sourceId) return EMPTY_RESULT
    const sorts = o.personal?.sorts ?? view.sorts
    const base = o.personal?.filter !== undefined ? o.personal.filter : view.filter
    const eff = effectiveFilter(base, o.extraFilter ?? null, (o.global as never) ?? null, view.sourceId)
    const want = Math.max(1, o.want ?? MAX_LIMIT)
    const req: Partial<QueryRequest> = {
      filter: eff.filter, sorts, search: o.search ?? '', group: o.group ?? null, subgroup: o.subgroup ?? null, totals: o.totals, subItems: o.subItems, manualOrder: o.manualOrder, viewId: view.id,
    }
    try {
      const rows: QueryRow[] = []
      let cursor: string | undefined
      let first: QueryResult | null = null
      do {
        const page = svc.query(view.sourceId, { ...req, limit: MAX_LIMIT, cursor })
        first ??= page
        rows.push(...page.rows)
        cursor = page.nextCursor ?? undefined
      } while (cursor && rows.length < want)
      return { rows, total: first.total, groups: first.groups, totals: first.totals, hasMore: !!cursor, error: null, matchIds: first.matchIds, filter: eff.filter, sorts, affected: eff.affected } satisfies ViewQueryResult
    } catch (e) {
      if (isDbError(e)) return { ...EMPTY_RESULT, error: { code: e.code, message: e.message } }
      throw e
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, version, view, o.search, o.personal, o.want, o.group, o.subgroup, o.totals, o.extraFilter, o.subItems, o.manualOrder, o.global])
}
