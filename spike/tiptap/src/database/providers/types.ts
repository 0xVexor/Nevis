// Connected providers and one-way imported sources (handoff §26). Adapters are pure TypeScript over an injected fetch and injected
// credentials, so they run on the gateway or the desktop alike and are tested with recorded fixtures. A fixture-only adapter is
// `adapter_tested`; it becomes `connection_verified` only after one real pull against a sandbox / live account (see docs ledger).
import type { Json } from '../model/types.ts'

export type ProviderId = 'gdrive' | 'figma' | 'zendesk' | 'github_pr' | 'github_issues' | 'gitlab' | 'jira' | 'asana'

export interface Credentials {
  /** OAuth access token or personal access token. Comes from the OS credential store / gateway secret storage, never from the Vault. */
  token: string
  /** ask the owner's identity provider for a new access token once after a 401; return null when the grant was revoked */
  refresh?: () => Promise<string | null>
}

export interface ProviderDeps {
  fetchImpl: typeof fetch
  credentials: Credentials
  now?: () => number
  /** injectable so tests do not wait for real backoff */
  sleep?: (ms: number) => Promise<void>
  /** self-managed hosts (GitLab) or API proxies */
  baseUrl?: string
}

export type ProviderErrorCode = 'invalid_reference' | 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable' | 'bad_response'

/** `not_found` / `forbidden` mean "not visible to this connection", which is never read as "deleted by the user". */
export class ProviderError extends Error {
  code: ProviderErrorCode
  status: number
  retryAfterMs?: number
  constructor(code: ProviderErrorCode, message: string, status = 0, retryAfterMs?: number) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** What a connected property caches: tagged so a stale value is visibly stale. */
export interface ProviderRecord {
  provider: ProviderId
  externalId: string
  canonicalUrl: string
  fields: Record<string, Json>
  providerRevision: string
  fetchedAt: number
}

export interface ImportItem {
  externalObjectId: string
  title: string
  url: string
  fields: Record<string, Json>
  revision: string
  /** the provider says it no longer exists (or the item moved out of scope) */
  deleted?: boolean
}
export interface PullPage {
  items: ImportItem[]
  nextCursor: string | null
}

export interface ConnectedProvider {
  id: ProviderId
  capabilities: { search: boolean; refresh: boolean; sourceSync: boolean }
  validateReference(input: string): { externalId: string; canonicalUrl: string }
  search(input: { query: string; cursor?: string; signal?: AbortSignal }): Promise<{ results: { externalId: string; title: string; url: string }[]; nextCursor: string | null }>
  retrieve(input: { externalId: string; signal?: AbortSignal }): Promise<ProviderRecord>
  pull?(input: { externalSourceId: string; cursor?: string; since?: string; signal?: AbortSignal }): Promise<PullPage>
}
