// Refresh of connected cells and pulls of imported sources through the gateway (which holds the credentials). The commit goes through the
// normal commands, so every cached value is a revision-guarded record with fetchedAt / providerRevision; a failure never blanks the cache.
import type { DatabaseService } from '../service.ts'
import type { Id, Json } from '../model/types.ts'
import type { GatewayClient } from '../gateway/client.ts'
import { GatewayError } from '../gateway/client.ts'
import type { ImportItem, ProviderRecord } from './types.ts'

type Status = 'ok' | 'unauthorized' | 'not_visible' | 'unavailable'
const STATUS_OF: Record<string, Status> = { unauthorized: 'unauthorized', forbidden: 'not_visible', not_found: 'not_visible', rate_limited: 'unavailable', unavailable: 'unavailable', offline: 'unavailable', bad_response: 'unavailable' }

export async function refreshConnected(svc: DatabaseService, client: GatewayClient, connectionId: string, pageId: Id, propertyId: Id): Promise<{ ok: boolean; status: Status; message?: string }> {
  const row = svc.state.row(pageId)
  const cell = row?.ext.cells[propertyId]?.value
  if (!row || !cell || cell.kind !== 'connected' || !cell.value) return { ok: false, status: 'unavailable', message: 'nothing to refresh' }
  const v = cell.value
  let record: ProviderRecord | null = null
  let status: Status = 'ok'
  let message: string | undefined
  try {
    record = await client.retrieve(v.provider, connectionId, v.externalId)
  } catch (e) {
    const code = e instanceof GatewayError ? (e.details as { providerCode?: string } | undefined)?.providerCode ?? e.code : 'unavailable'
    status = STATUS_OF[code] ?? 'unavailable'
    message = e instanceof Error ? e.message : String(e)
  }
  // inaccessible is never read as "deleted by the user": the link and the last good cache stay, with a visible status
  const r = await svc.tryExec([{ type: 'connected.store', payload: { pageId, propertyId, value: { provider: v.provider, externalId: v.externalId, canonicalUrl: v.canonicalUrl, cache: record ? { fields: record.fields, providerRevision: record.providerRevision, fetchedAt: record.fetchedAt } : null, status } as unknown as Json } as Json }], { origin: 'external' })
  return { ok: !!record && r.ok, status, message: r.ok ? message : r.message }
}

/** One pull of an imported source (all pages) applied in one commit. */
export async function pullSource(svc: DatabaseService, client: GatewayClient, sourceId: Id, connectionId: string, since?: string): Promise<{ created: number; updated: number; unchanged: number; tombstoned: number; unmapped: number; complete: boolean }> {
  const imp = (svc.state.get('source', sourceId)?.settings as { import?: { provider: string; externalSourceId: string } } | null)?.import
  if (!imp) throw new Error('this source is not linked to an external source')
  const res = await client.pull(imp.provider, connectionId, imp.externalSourceId, since)
  const fetchedAt = svc.now()
  const items: ImportItem[] = res.items
  const out = await svc.one<{ created: number; updated: number; unchanged: number; tombstoned: number; unmapped: unknown[] }>('external.apply', { sourceId, items, complete: res.complete, fetchedAt }, { origin: 'import', operationId: `pull:${sourceId}:${fetchedAt}` })
  return { created: out.created, updated: out.updated, unchanged: out.unchanged, tombstoned: out.tombstoned, unmapped: out.unmapped.length, complete: res.complete }
}
