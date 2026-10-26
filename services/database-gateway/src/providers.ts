// Provider calls on behalf of the owner (handoff §26). The gateway holds the connection credentials (connections file); the Vault and the
// desktop only know a connection id. Provider failures answer 424 with the provider's own code so the app can say "reconnect" or
// "not visible to this connection" instead of treating an unreachable object as deleted.
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import { HttpError, type Req } from './http.ts'
import { requireOwner } from './auth.ts'
import type { Connections } from './outbox.ts'
import { CONNECTED } from '../../../spike/tiptap/src/database/providers/connected.ts'
import { SOURCES, pullAll } from '../../../spike/tiptap/src/database/providers/sources.ts'
import { ProviderError, type ConnectedProvider, type ProviderDeps } from '../../../spike/tiptap/src/database/providers/types.ts'

export interface ConnectionConfig { token?: string; baseUrl?: string }

export function providerRoutes(db: Db, cfg: Config, conns: () => Connections, fetchImpl: typeof fetch, now: () => number = Date.now) {
  const build = (providerId: unknown, connectionId: unknown, sourceMode: boolean): ConnectedProvider => {
    if (typeof providerId !== 'string' || typeof connectionId !== 'string') throw new HttpError(400, 'invalid_request', 'provider and connectionId are required')
    const make = sourceMode ? SOURCES[providerId] : CONNECTED[providerId]
    if (!make) throw new HttpError(422, 'unknown_provider', `unknown provider ${providerId}`)
    const c = conns()[connectionId] as ConnectionConfig | undefined
    if (!c?.token) throw new HttpError(424, 'provider_error', 'the connection is not configured on this gateway', { providerCode: 'unauthorized', missingCredentials: true })
    if (c.baseUrl && !(/^https:\/\//.test(c.baseUrl) || (cfg.dev && /^http:\/\/(localhost|127\.0\.0\.1)/.test(c.baseUrl)))) throw new HttpError(422, 'invalid_connection', 'baseUrl must use https')
    const deps: ProviderDeps = { fetchImpl, credentials: { token: c.token }, baseUrl: c.baseUrl, now }
    return make(deps)
  }
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f()
    } catch (e) {
      if (e instanceof ProviderError) throw new HttpError(424, 'provider_error', e.message, { providerCode: e.code, providerStatus: e.status, retryAfterMs: e.retryAfterMs })
      throw e
    }
  }
  return {
    retrieve: async (req: Req) => {
      requireOwner(db, req)
      const b = req.body as { provider?: string; connectionId?: string; externalId?: string } | undefined
      const p = build(b?.provider, b?.connectionId, false)
      if (typeof b?.externalId !== 'string') throw new HttpError(400, 'invalid_request', 'externalId is required')
      return { body: await wrap(() => p.retrieve({ externalId: b.externalId! })) }
    },
    pull: async (req: Req) => {
      requireOwner(db, req)
      const b = req.body as { provider?: string; connectionId?: string; externalSourceId?: string; since?: string } | undefined
      const p = build(b?.provider, b?.connectionId, true)
      if (typeof b?.externalSourceId !== 'string') throw new HttpError(400, 'invalid_request', 'externalSourceId is required')
      return { body: await wrap(() => pullAll(p, b.externalSourceId!, { since: b.since })) }
    },
  }
}
