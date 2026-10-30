// Client of the optional Nevis gateway (services/database-gateway). Everything here is a plain HTTP call with an injectable fetch, so it is
// tested against the real gateway code. The owner token is a secret of this device: it is kept apart from the Vault.
import type { Id, Json } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { optionsOf } from '../props/config.ts'
import { validateFormConfig, type FormConfig } from '../forms.ts'
import type { ImportItem, ProviderRecord } from '../providers/types.ts'

export interface GatewayConfig {
  url: string
  token: string
}
export type GatewayStatus = 'ready' | 'needs_setup' | 'offline' | 'unauthorized' | 'unsupported' | 'error'

export class GatewayError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface PublishedProperty { id: Id; kind: string; name: string; config: Json; choices?: { id: Id; label: string }[] }
export interface PublicationPayload { title: string; form: FormConfig; properties: PublishedProperty[] }
export interface InboxItem { id: string; publicationId: string; formVersion: number; submissionId: string; answers: Record<string, Json>; ackToken: string; createdAt: number; seq: number }
export type AckResult = { ok: true; operationId: string; pageId?: string } | { ok: false; reason: string }

export class GatewayClient {
  cfg: GatewayConfig
  fetchImpl: typeof fetch
  constructor(cfg: GatewayConfig, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.cfg = { url: cfg.url.replace(/\/+$/, ''), token: cfg.token }
    this.fetchImpl = fetchImpl
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(this.cfg.url + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${this.cfg.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      throw new GatewayError(0, 'offline', e instanceof Error ? e.message : 'the gateway cannot be reached')
    }
    const text = await res.text()
    const json = text ? (JSON.parse(text) as { error?: { code: string; message: string; details?: unknown } }) : null
    if (!res.ok) throw new GatewayError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.details)
    return json as T
  }

  /** `ready` only when the gateway answers and accepts the owner token. */
  async status(): Promise<GatewayStatus> {
    try {
      await this.call('GET', '/v1/health', undefined, false)
      await this.call('GET', '/v1/inbox?limit=1')
      return 'ready'
    } catch (e) {
      if (e instanceof GatewayError) return e.status === 0 ? 'offline' : e.status === 401 ? 'unauthorized' : e.status === 501 ? 'unsupported' : 'error'
      return 'error'
    }
  }
  capabilities() {
    return this.call<Record<string, string>>('GET', '/v1/capabilities', undefined, false)
  }
  publish(p: PublicationPayload) {
    return this.call<{ id: string; publicId: string; version: number; url: string }>('POST', '/v1/publications', p)
  }
  update(id: string, p: PublicationPayload, expectedVersion: number) {
    return this.call<{ id: string; publicId: string; version: number; url: string }>('PUT', `/v1/publications/${id}`, { ...p, expectedVersion })
  }
  revoke(id: string) {
    return this.call<{ id: string; status: string }>('DELETE', `/v1/publications/${id}`)
  }
  publicationStatus(id: string) {
    return this.call<{ id: string; publicId: string; version: number; status: string; submissions: Record<string, number> }>('GET', `/v1/publications/${id}`)
  }
  inbox(cursor = 0, limit = 50) {
    return this.call<{ items: InboxItem[]; nextCursor: number }>('GET', `/v1/inbox?cursor=${cursor}&limit=${limit}`)
  }
  ack(id: string, ackToken: string, result: AckResult) {
    return this.call<{ id: string; status: string }>('POST', `/v1/inbox/${id}/ack`, { ackToken, result })
  }
  retrieve(provider: string, connectionId: string, externalId: string) {
    return this.call<ProviderRecord>('POST', '/v1/providers/retrieve', { provider, connectionId, externalId })
  }
  pull(provider: string, connectionId: string, externalSourceId: string, since?: string) {
    return this.call<{ items: ImportItem[]; complete: boolean }>('POST', '/v1/providers/pull', { provider, connectionId, externalSourceId, since })
  }
  sendMessage(idempotencyKey: string, request: Json) {
    return this.call<{ key: string; status: string; attempts: number; retryAt: number | null; result: Json }>('POST', '/v1/outbox', { idempotencyKey, request })
  }
}

// ───── settings kept on this device ─────

export const GATEWAY_URL_KEY = 'not.db.gateway'
export const GATEWAY_TOKEN_KEY = 'not.db.gatewayToken'
export const PUBLICATIONS_KEY = 'not.db.publications'

export function gatewayConfig(): GatewayConfig | null {
  try {
    const url = localStorage.getItem(GATEWAY_URL_KEY) ?? ''
    const token = localStorage.getItem(GATEWAY_TOKEN_KEY) ?? ''
    return url && token ? { url, token } : null
  } catch {
    return null
  }
}

export type PublicationLink = { id: string; publicId: string; version: number; url: string; viewId: Id }
export const loadLinks = (): Record<Id, PublicationLink> => {
  try { return JSON.parse(localStorage.getItem(PUBLICATIONS_KEY) ?? '{}') as Record<Id, PublicationLink> } catch { return {} }
}
export const saveLink = (l: PublicationLink | null, viewId: Id) => {
  try {
    const all = loadLinks()
    if (l) all[viewId] = l
    else delete all[viewId]
    localStorage.setItem(PUBLICATIONS_KEY, JSON.stringify(all))
  } catch { /* the link is a convenience; the gateway still has the publication */ }
}

// ───── building what gets published ─────

/**
 * The projection of one form view: only the properties its questions ask for, with only the choices a question offers. Never the whole
 * Source. Relation / people choices carry labels because a respondent cannot see the database to look them up.
 */
export function buildPublication(svc: DatabaseService, viewId: Id): PublicationPayload {
  const view = svc.state.get('view', viewId)
  if (!view || view.type !== 'form' || !view.sourceId) throw new GatewayError(0, 'invalid', 'this is not a form view')
  const form = view.configuration as unknown as FormConfig
  const problems = validateFormConfig(form, (id) => svc.state.prop(id))
  if (problems.length) throw new GatewayError(0, 'invalid', problems[0].message)
  const props: PublishedProperty[] = []
  for (const q of form.questions) {
    const d = svc.state.prop(q.propertyId)!
    if (props.some((p) => p.id === d.id)) continue
    const out: PublishedProperty = { id: d.id, kind: d.kind, name: d.name, config: ['select', 'multi_select', 'status'].includes(d.kind) ? ({ options: optionsOf(d) } as unknown as Json) : {} }
    if (d.kind === 'relation') out.choices = (q.optionProjection ?? []).map((id) => ({ id, label: svc.state.pages.get(id)?.title ?? '' }))
    if (d.kind === 'people') out.choices = (q.optionProjection ?? []).map((id) => ({ id, label: svc.state.get('principal', id)?.displayName ?? '' }))
    props.push(out)
  }
  return { title: svc.state.get('container', view.containerId)?.title || view.name, form, properties: props }
}

// ───── pulling submissions ─────

/**
 * Apply every submission that is waiting in the inbox and acknowledge it. Each one is applied through `form.submit` with the gateway's
 * submission id, so a lost acknowledgment (crash between apply and ack) re-applies to the same receipt instead of creating a second row.
 * A submission that no longer fits the current form is kept on the gateway as rejected, with the reason, for the owner to repair.
 */
export async function pullInbox(svc: DatabaseService, client: GatewayClient, links: Record<Id, PublicationLink> = loadLinks()): Promise<{ applied: number; rejected: number }> {
  const byPublication = new Map(Object.values(links).map((l) => [l.id, l]))
  let applied = 0
  let rejected = 0
  let cursor = 0
  for (let page = 0; page < 20; page++) {
    const { items, nextCursor } = await client.inbox(cursor)
    if (!items.length) break
    for (const item of items) {
      const link = byPublication.get(item.publicationId)
      let result: AckResult
      if (!link) result = { ok: false, reason: 'this device has no form linked to the publication' }
      else {
        const view = svc.state.get('view', link.viewId)
        const cfg = view?.configuration as unknown as FormConfig | undefined
        const r = view && cfg ? await svc.tryExec([{ type: 'form.submit', payload: { formViewId: link.viewId, version: cfg.version, submissionId: item.submissionId, answers: item.answers } }], { operationId: `inbox:${item.id}`, origin: 'import' }) : null
        if (r && r.ok) result = { ok: true, operationId: r.commit.operationId, pageId: ((r.result as { pageId?: string } | null)?.pageId) ?? undefined }
        else result = { ok: false, reason: r ? `${r.code}: ${r.message}` : 'the form no longer exists' }
      }
      try {
        await client.ack(item.id, item.ackToken, result)
        result.ok ? applied++ : rejected++
      } catch (e) {
        if (!(e instanceof GatewayError) || e.status === 0) return { applied, rejected } // offline: it will be delivered again
      }
    }
    cursor = nextCursor
  }
  return { applied, rejected }
}
