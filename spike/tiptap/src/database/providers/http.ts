// Shared request helper: bearer auth, one credential refresh after a 401, bounded retry with Retry-After, uniform error codes.
import { ProviderError, type ProviderDeps } from './types.ts'

export interface Result {
  json: unknown
  headers: Headers
  status: number
}

const MAX_ATTEMPTS = 4
const MAX_INLINE_WAIT = 15_000
const BACKOFF = [1_000, 3_000, 8_000] // inline retries inside one request; longer waits are the caller's schedule

export async function request(deps: ProviderDeps, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<Result> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let token = deps.credentials.token
  let refreshed = false
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await deps.fetchImpl(url, {
        method: init.method ?? 'GET',
        signal: init.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch (e) {
      if (init.signal?.aborted) throw e
      if (attempt >= MAX_ATTEMPTS) throw new ProviderError('unavailable', e instanceof Error ? e.message : 'network error')
      await sleep(BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)])
      continue
    }
    if (res.ok) {
      const text = await res.text()
      try {
        return { json: text ? JSON.parse(text) : null, headers: res.headers, status: res.status }
      } catch {
        throw new ProviderError('bad_response', 'the provider answered with something that is not JSON', res.status)
      }
    }
    if (res.status === 401) {
      if (!refreshed && deps.credentials.refresh) {
        refreshed = true
        const next = await deps.credentials.refresh()
        if (next) { token = next; continue }
      }
      throw new ProviderError('unauthorized', 'the connection was refused or its access was revoked; reconnect it', 401)
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') !== '0' && !res.headers.get('retry-after')) throw new ProviderError('forbidden', 'this connection may not read that object', 403)
    if (res.status === 404) throw new ProviderError('not_found', 'the object does not exist or is not visible to this connection', 404)
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 300_000) : BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)]
      if (attempt >= MAX_ATTEMPTS) throw new ProviderError(res.status >= 500 ? 'unavailable' : 'rate_limited', `the provider answered HTTP ${res.status}`, res.status, wait)
      // a long Retry-After is handed back to the caller (who schedules the next try) instead of holding a request open
      if (wait > MAX_INLINE_WAIT) throw new ProviderError('rate_limited', `the provider asks to wait ${Math.ceil(wait / 1000)} s`, res.status, wait)
      await sleep(wait)
      continue
    }
    throw new ProviderError('bad_response', `the provider answered HTTP ${res.status}`, res.status)
  }
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const at = (deps: ProviderDeps) => (deps.now ?? Date.now)()

/** Link header `rel="next"` (GitHub style). */
export function nextLink(h: Headers): string | null {
  const m = /<([^>]+)>;\s*rel="next"/.exec(h.get('link') ?? '')
  return m ? m[1] : null
}
