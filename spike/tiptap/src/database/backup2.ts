// Native backup bundle v2 (handoff §27): every canonical database record, with a manifest of hashes so a restore can be
// validated completely before anything is touched. Secrets, the disposable index, journals and runtime tokens are never included.
// Pages (with their row extensions) and attachment bytes travel in the existing v1 envelope; v1 files still import unchanged.
import type { Id, Json, RecordKind } from './model/types.ts'
import { RECORD_KINDS } from './model/types.ts'
import { hash } from './model/json.ts'
import type { DbState } from './state.ts'

export const BUNDLE_FORMAT = 'noviq-database-bundle'
export const BUNDLE_VERSION = 2

export type Bundle = {
  format: typeof BUNDLE_FORMAT
  version: 2
  createdAt: string
  vaultId: Id
  records: { [K in RecordKind]?: Json[] }
  history?: { recordKind: string; id: Id; revision: number; body: Json }[]
  counts: Record<string, number>
  hashes: Record<string, string>
  manifestHash: string
}

export type BundleProblem = { code: string; kind?: string; id?: Id; detail: string; severity: 'error' | 'warning' }

export function buildBundle(state: DbState, opts: { createdAt?: string; history?: Bundle['history'] } = {}): Bundle {
  const records: Bundle['records'] = {}
  const counts: Record<string, number> = {}
  const hashes: Record<string, string> = {}
  for (const kind of RECORD_KINDS) {
    const list = state.all(kind).sort((a, b) => (a.id < b.id ? -1 : 1)) as unknown as Json[]
    if (!list.length) continue
    records[kind] = list
    counts[kind] = list.length
    hashes[kind] = hash(list)
  }
  const b: Bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: opts.createdAt ?? new Date().toISOString(), vaultId: state.vaultId, records,
    ...(opts.history ? { history: opts.history } : {}), counts, hashes, manifestHash: hash(hashes),
  }
  return b
}

const REF_FIELDS: Record<string, [RecordKind, string][]> = {
  property: [['source', 'sourceId']],
  source: [['container', 'ownerContainerId'], ['property', 'titlePropertyId']],
  view: [['container', 'containerId']],
  relation: [['property', 'propertyId'], ['source', 'sourceId'], ['source', 'targetSourceId']],
  edge: [['relation', 'definitionId']],
  template: [['source', 'sourceId']],
  workflow: [['source', 'sourceId']],
  allocator: [['source', 'sourceId'], ['property', 'propertyId']],
}

/** Validate the whole bundle: structure, duplicate ids, hashes, references. Nothing is applied by this function. */
export function validateBundle(b: unknown, opts: { pageIds?: Set<Id> } = {}): BundleProblem[] {
  const p: BundleProblem[] = []
  const err = (code: string, detail: string, kind?: string, id?: Id) => p.push({ code, detail, kind, id, severity: 'error' })
  if (!b || typeof b !== 'object') return [{ code: 'FORMAT', detail: 'not an object', severity: 'error' }]
  const x = b as Bundle
  if (x.format !== BUNDLE_FORMAT) return [{ code: 'FORMAT', detail: 'not a Noviq database bundle', severity: 'error' }]
  if (x.version !== BUNDLE_VERSION) return [{ code: 'VERSION', detail: `unsupported bundle version ${String(x.version)}`, severity: 'error' }]
  if (!x.records || typeof x.records !== 'object') return [{ code: 'FORMAT', detail: 'records missing', severity: 'error' }]
  const ids = new Map<RecordKind, Set<Id>>()
  for (const kind of RECORD_KINDS) ids.set(kind, new Set())
  for (const kind of RECORD_KINDS) {
    const list = x.records[kind] ?? []
    if (!Array.isArray(list)) { err('FORMAT', `${kind} is not a list`, kind); continue }
    for (const r of list as unknown as Record<string, unknown>[]) {
      if (!r || typeof r.id !== 'string' || !r.id) { err('FORMAT', 'record without id', kind); continue }
      if (r.format !== 1) err('FORMAT', `record format ${String(r.format)} is not supported`, kind, r.id)
      if (ids.get(kind)!.has(r.id)) err('DUPLICATE', `duplicate ${kind} id`, kind, r.id)
      ids.get(kind)!.add(r.id)
    }
    if (x.hashes?.[kind] !== undefined && hash(list) !== x.hashes[kind]) err('HASH', `${kind} records do not match the manifest`, kind)
  }
  if (x.manifestHash !== hash(x.hashes ?? {})) err('HASH', 'manifest hash does not match', 'manifest')
  for (const [kind, refs] of Object.entries(REF_FIELDS)) {
    for (const r of (x.records[kind as RecordKind] ?? []) as unknown as Record<string, unknown>[]) {
      for (const [tk, field] of refs) {
        const v = r[field]
        if (typeof v === 'string' && v && !ids.get(tk)!.has(v)) err('REFERENCE', `${kind}.${field} points at a missing ${tk}`, kind, r.id as string)
      }
    }
  }
  for (const e of (x.records.edge ?? []) as unknown as { id: Id; fromPageId: Id; toPageId: Id }[]) {
    if (opts.pageIds && (!opts.pageIds.has(e.fromPageId) || !opts.pageIds.has(e.toPageId)))
      p.push({ code: 'PENDING', kind: 'edge', id: e.id, detail: 'a linked page is not in this backup; the link stays pending', severity: 'warning' })
  }
  return p
}

/** Deep id remap used by "merge": replaces ids used as values AND as object keys (row cells are keyed by property id). */
export function remapIds<T>(value: T, map: Map<Id, Id>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[map.get(k) ?? k] = remapIds(v, map)
    return out as T
  }
  return value
}
