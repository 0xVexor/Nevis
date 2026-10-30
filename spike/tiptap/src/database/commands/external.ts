// Connected properties and one-way imported sources (handoff §26). The provider calls happen outside the coordinator (gateway or runtime);
// these commands only record what came back, so a bad network never leaves a half-applied batch and every step is a revision-guarded commit.
//  - connected.store:    cache for one connected cell (tagged fetchedAt / providerRevision); a failed refresh keeps the old cache and sets a status
//  - external.configure: source <-> external source link, field map, explicit identity map
//  - external.apply:     upsert by (provider, externalSourceId, externalObjectId); resync is idempotent; absent / deleted items are tombstoned, never purged
// Fields mapped from a provider are read-only for people (origin 'import' may write them); every other property stays editable and is never overwritten.
import type { Cell, Definition, ExternalIdentity, Id, ImportSettings, Json } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { validateCell } from '../props/registry.ts'
import { optionsOf } from '../props/config.ts'
import { matchKey, parseStrictNumber, textToRuns } from '../text.ts'
import { isCivil, parseIsoInstant } from '../dates.ts'
import { register, type Ctx } from './coordinator.ts'
import { property, source } from './util.ts'
import { createRow } from './rows.ts'

const PROVIDERS = ['github_issues', 'gitlab', 'jira', 'asana']
export const importSettings = (cx: Ctx, sourceId: Id): ImportSettings | null => ((source(cx, sourceId).settings as { import?: ImportSettings } | null)?.import ?? null)

/** Properties (and '$title') a person may not edit because a provider owns them. */
export function importReadOnly(cx: Ctx, sourceId: Id): Set<string> {
  const s = importSettings(cx, sourceId)
  return new Set(s ? Object.values(s.fieldMap) : [])
}
export function assertNotImported(cx: Ctx, sourceId: Id, propertyOrTitle: string) {
  if (cx.env.origin === 'import') return
  if (importReadOnly(cx, sourceId).has(propertyOrTitle)) fail('READ_ONLY', 'this value comes from the connected service; change it there', { propertyId: propertyOrTitle })
}

type ConnectedPayload = { provider: string; externalId: string; canonicalUrl: string; cache: { fields: Record<string, Json>; providerRevision: string; fetchedAt: number } | null; status?: 'ok' | 'unauthorized' | 'not_visible' | 'unavailable' }

register('connected.store', (cx, p: { pageId: Id; propertyId: Id; value: ConnectedPayload }) => {
  const row = cx.d.row(p.pageId)
  if (!row) fail('NOT_FOUND', 'item not found', { pageId: p.pageId })
  cx.access.assertRow(cx.env.actorId, row!, 'edit_rows')
  const def = property(cx, p.propertyId)
  if (def.kind !== 'connected' || def.sourceId !== row!.sourceId) fail('SCHEMA_MISMATCH', 'not a connected property of this source')
  const prev = row!.ext.cells[def.id]?.value
  if (!prev || prev.kind !== 'connected' || !prev.value || prev.value.externalId !== p.value.externalId) fail('REVISION_CONFLICT', 'the link changed while it was being refreshed; refresh again')
  // a refresh that failed keeps the last good cache (never blanked), and says so
  const cache = p.value.cache ?? prev.value.cache
  const value = validateCell(def, { kind: 'connected', value: { ...p.value, cache } }) as Extract<Cell, { kind: 'connected' }>
  const page = cx.d.mutPage(p.pageId)
  page.database!.cells[def.id] = { value, stamp: cx.stamp() }
})

const NO_IMPORT_KINDS = ['formula', 'rollup', 'button', 'relation', 'unique_id', 'files', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'verification', 'connected']

register('external.configure', (cx, p: { sourceId: Id; provider: string; externalSourceId: string; fieldMap: Record<string, Id>; identityMap?: Record<string, Id>; statusMap?: Record<string, Id> }) => {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_schema')
  if (!PROVIDERS.includes(p.provider)) fail('INVALID_VALUE', `unknown import provider ${String(p.provider)}`)
  if (typeof p.externalSourceId !== 'string' || !p.externalSourceId || p.externalSourceId.length > 200) fail('INVALID_VALUE', 'externalSourceId is required')
  for (const [field, target] of Object.entries(p.fieldMap ?? {})) {
    if (target === '$title') continue
    const d = property(cx, target)
    if (d.sourceId !== src.id) fail('SCHEMA_MISMATCH', `field ${field} maps to a property of another source`, { propertyId: target })
    if (NO_IMPORT_KINDS.includes(d.kind)) fail('INVALID_VALUE', `${d.name} cannot receive imported values`, { propertyId: target })
  }
  for (const principal of Object.values(p.identityMap ?? {})) if (!cx.d.get('principal', principal)) fail('NOT_FOUND', 'identity map refers to an unknown person', { principalId: principal })
  const settings = { ...((src.settings as Record<string, Json>) ?? {}) }
  settings.import = { provider: p.provider, externalSourceId: p.externalSourceId, fieldMap: p.fieldMap ?? {}, identityMap: p.identityMap ?? {}, statusMap: p.statusMap ?? {} } as unknown as Json
  cx.d.mut('source', src.id).settings = settings as Json
})

type Item = { externalObjectId: string; title: string; url: string; fields: Record<string, Json>; revision: string; deleted?: boolean }

function toCell(def: Definition, value: Json, imp: ImportSettings): { cell: Cell | null } | { unmapped: string } {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return { cell: null }
  try {
    switch (def.kind) {
      case 'text': return { cell: validateCell(def, { kind: 'text', runs: textToRuns(Array.isArray(value) ? value.join(', ') : String(value)) }) }
      case 'number': {
        const n = typeof value === 'number' ? value : parseStrictNumber(String(value))
        return n === null ? { unmapped: String(value) } : { cell: validateCell(def, { kind: 'number', value: n }) }
      }
      case 'checkbox': return { cell: { kind: 'checkbox', value: value === true || value === 'closed' || value === 'merged' || value === 'done' } }
      case 'url': case 'email': case 'phone': return { cell: validateCell(def, { kind: def.kind, value: String(value) } as Cell) }
      case 'date': {
        const s = String(value)
        if (isCivil(s)) return { cell: validateCell(def, { kind: 'date', value: { kind: 'date', start: s, end: null } }) }
        const ms = parseIsoInstant(s, null)
        return ms === null ? { unmapped: s } : { cell: validateCell(def, { kind: 'date', value: { kind: 'datetime', start: new Date(ms).toISOString(), end: null, timeZone: null } }) }
      }
      case 'select': case 'status': {
        const label = String(value)
        const mapped = imp.statusMap[label]
        const opt = (mapped && optionsOf(def).find((o) => o.id === mapped)) || optionsOf(def).find((o) => matchKey(o.name) === matchKey(label))
        return opt ? { cell: { kind: def.kind, optionId: opt.id } as Cell } : { unmapped: label }
      }
      case 'multi_select': {
        const ids: Id[] = []
        for (const l of (Array.isArray(value) ? value : [value]).map(String)) {
          const o = optionsOf(def).find((x) => matchKey(x.name) === matchKey(l))
          if (!o) return { unmapped: l }
          ids.push(o.id)
        }
        return { cell: validateCell(def, { kind: 'multi_select', optionIds: ids }) }
      }
      case 'people': {
        const who = imp.identityMap[String(value)]
        return who ? { cell: { kind: 'people', principalIds: [who] } } : { unmapped: String(value) } // never guess a person from a login
      }
      default: return { unmapped: String(value) }
    }
  } catch {
    return { unmapped: String(value) }
  }
}

register('external.apply', (cx, p: { sourceId: Id; items: Item[]; complete?: boolean; fetchedAt: number }) => {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_rows')
  if (cx.env.origin !== 'import') fail('INVALID_COMMAND', 'external.apply must run with origin "import"')
  const imp = importSettings(cx, src.id)
  if (!imp) fail('SCHEMA_MISMATCH', 'this source is not linked to an external source')
  if (p.items.length > 5000) fail('QUOTA', 'apply at most 5000 items per batch')
  const identity = (id: string): ExternalIdentity => ({ provider: imp!.provider, externalSourceId: imp!.externalSourceId, externalObjectId: id, revision: '', fetchedAt: p.fetchedAt, url: '', tombstoned: false })
  const known = new Map<string, Id>()
  for (const r of cx.d.rowsOf(src.id)) if (r.ext.external && r.ext.external.provider === imp!.provider && r.ext.external.externalSourceId === imp!.externalSourceId) known.set(r.ext.external.externalObjectId, r.page.id)
  const out = { created: 0, updated: 0, unchanged: 0, tombstoned: 0, restored: 0, unmapped: [] as { field: string; value: string }[] }
  const seen = new Set<string>()
  const values = (item: Item): { explicit: Record<Id, Cell>; clear: Id[]; title: string | null } => {
    const explicit: Record<Id, Cell> = {}
    const clear: Id[] = []
    let title: string | null = null
    for (const [field, target] of Object.entries(imp!.fieldMap)) {
      const v = field === 'title' ? item.title : item.fields[field]
      if (target === '$title') { title = typeof v === 'string' ? v : item.title; continue }
      const def = property(cx, target)
      const r = toCell(def, v as Json, imp!)
      if ('unmapped' in r) { out.unmapped.push({ field, value: r.unmapped }); continue }
      if (r.cell) explicit[target] = r.cell
      else clear.push(target)
    }
    return { explicit, clear, title }
  }
  for (const item of p.items) {
    seen.add(item.externalObjectId)
    const pageId = known.get(item.externalObjectId)
    if (!pageId) {
      if (item.deleted) continue
      const v = values(item)
      const created = createRow(cx, { sourceId: src.id, title: v.title ?? item.title, explicitValues: v.explicit })
      const page = cx.d.mutPage(created.pageId)
      page.database!.external = { ...identity(item.externalObjectId), revision: item.revision, url: item.url }
      known.set(item.externalObjectId, created.pageId)
      out.created++
      continue
    }
    const page = cx.d.mutPage(pageId)
    const ext = page.database!
    const was = ext.external!
    if (item.deleted) {
      if (!was.tombstoned) { ext.external = { ...was, tombstoned: true, fetchedAt: p.fetchedAt }; out.tombstoned++ }
      continue
    }
    if (was.revision === item.revision && !was.tombstoned) { out.unchanged++; continue }
    const v = values(item)
    if (v.title !== null && page.title !== v.title) page.title = v.title
    for (const [pid, cell] of Object.entries(v.explicit)) {
      const prev = ext.cells[pid]?.value
      if (!prev || JSON.stringify(prev) !== JSON.stringify(cell)) ext.cells[pid] = { value: cell, stamp: cx.stamp() }
    }
    for (const pid of v.clear) delete ext.cells[pid]
    if (was.tombstoned) out.restored++
    ext.external = { ...was, revision: item.revision, url: item.url, fetchedAt: p.fetchedAt, tombstoned: false }
    out.updated++
  }
  if (p.complete) {
    // a complete listing that no longer contains an item means the provider dropped it: tombstone (history and local overlays stay)
    for (const [objId, pageId] of known) {
      if (seen.has(objId)) continue
      const page = cx.d.page(pageId)!
      if (page.database!.external!.tombstoned) continue
      cx.d.mutPage(pageId).database!.external = { ...page.database!.external!, tombstoned: true, fetchedAt: p.fetchedAt }
      out.tombstoned++
    }
  }
  return out as unknown as Json
})
