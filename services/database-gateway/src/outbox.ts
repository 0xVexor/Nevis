// Outbound messages (webhooks) with idempotency keys, bounded retries and a hard SSRF guard (handoff §21, §24).
//  - the request must be https (http only for loopback in dev) and may not resolve to a private / loopback / link-local address
//  - redirects are never followed
//  - credentials come from the gateway's connections file by connection id, never from the Vault or the request body
//  - a failure after the request may have reached the receiver is "uncertain": it is held for review unless the request says it is idempotent
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import type { Db } from './db.ts'
import { tx } from './db.ts'
import type { Config } from './config.ts'
import { HttpError } from './http.ts'

export const BACKOFF_MS = [1_000, 5_000, 30_000, 300_000]
export const MAX_ATTEMPTS = 5

export interface WebhookRequest {
  type: 'webhook'
  url: string
  method?: 'POST' | 'PUT' | 'PATCH'
  body?: unknown
  connectionId?: string
  /** the receiver deduplicates on the Idempotency-Key header, so an uncertain outcome may be retried */
  idempotent?: boolean
}

export type Outcome =
  | { state: 'succeeded'; status: number }
  | { state: 'retry'; retryAfterMs: number; reason: string }
  | { state: 'failed'; reason: string }
  | { state: 'needs_review'; reason: string }

export interface Deps {
  fetchImpl: typeof fetch
  resolve: (host: string) => Promise<string[]>
  now: () => number
}

export const realDeps: Deps = {
  fetchImpl: (...a) => fetch(...a),
  resolve: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
  now: () => Date.now(),
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
  }
  if (v === 6) {
    const x = ip.toLowerCase()
    if (x === '::1' || x === '::') return true
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7))
    return x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff')
  }
  return true // not an IP at all: refuse
}

export type Connections = Record<string, { headers?: Record<string, string>; token?: string; baseUrl?: string }>
export function loadConnections(path: string): Connections {
  if (!path) return {}
  const c = JSON.parse(readFileSync(path, 'utf8')) as Connections
  return c && typeof c === 'object' ? c : {}
}

export async function checkTarget(rawUrl: string, cfg: Pick<Config, 'dev' | 'webhookAllowlist'>, resolve: Deps['resolve']): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new HttpError(422, 'invalid_target', 'the address is not a valid URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopbackDev = cfg.dev && url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')
  if (url.protocol !== 'https:' && !loopbackDev) throw new HttpError(422, 'invalid_target', 'webhook addresses must use https')
  if (url.username || url.password) throw new HttpError(422, 'invalid_target', 'credentials in the address are not allowed')
  if (cfg.webhookAllowlist.length && !cfg.webhookAllowlist.some((h) => host === h || host.endsWith('.' + h))) throw new HttpError(403, 'target_not_allowed', 'this host is not on the webhook allowlist')
  if (!loopbackDev) {
    const addrs = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[])
    if (!addrs.length) throw new HttpError(422, 'invalid_target', 'the host could not be resolved')
    if (addrs.some(isPrivateAddress)) throw new HttpError(403, 'target_not_allowed', 'this address points into a private network')
  }
  return url
}

export async function executeWebhook(req: WebhookRequest, idempotencyKey: string, cfg: Config, conns: Connections, deps: Deps, attempt: number): Promise<Outcome> {
  let url: URL
  try {
    url = await checkTarget(req.url, cfg, deps.resolve)
  } catch (e) {
    return { state: 'failed', reason: e instanceof HttpError ? e.message : 'invalid target' }
  }
  const conn = req.connectionId ? conns[req.connectionId] : undefined
  if (req.connectionId && !conn) return { state: 'failed', reason: 'MISSING_CREDENTIALS: the connection is not configured on this gateway' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  let res: Response
  try {
    res = await deps.fetchImpl(url, {
      method: req.method ?? 'POST',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'user-agent': 'noviq-gateway/0.1', ...(conn?.headers ?? {}) },
      body: JSON.stringify(req.body ?? {}),
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = (e as Error)?.name === 'AbortError'
    const code = ((e as { cause?: { code?: string } })?.cause?.code ?? '') as string
    if (!aborted && ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return { state: 'retry', retryAfterMs: BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)], reason: code }
    // the request may have reached the receiver
    return req.idempotent
      ? { state: 'retry', retryAfterMs: BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)], reason: aborted ? 'timeout' : 'network error' }
      : { state: 'needs_review', reason: aborted ? 'UNCERTAIN: the request timed out and may have been delivered' : 'UNCERTAIN: the connection broke and the request may have been delivered' }
  }
  clearTimeout(timer)
  try { await res.body?.cancel() } catch { /* body is not needed */ }
  if (res.status >= 200 && res.status < 300) return { state: 'succeeded', status: res.status }
  if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504 || res.status === 408) {
    const ra = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3600_000) : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
    return { state: 'retry', retryAfterMs: wait, reason: `HTTP ${res.status}` }
  }
  if (res.status === 401 || res.status === 403) return { state: 'failed', reason: `MISSING_CREDENTIALS: the receiver refused access (HTTP ${res.status})` }
  return { state: 'failed', reason: `HTTP ${res.status}` }
}

/** Persist an outbox entry (idempotent by key) and run one attempt. Returns the stored state. */
export class Outbox {
  db: Db
  cfg: Config
  conns: Connections
  deps: Deps
  constructor(db: Db, cfg: Config, conns: Connections, deps: Deps = realDeps) {
    this.db = db
    this.cfg = cfg
    this.conns = conns
    this.deps = deps
  }

  enqueue(ownerId: string, key: string, request: WebhookRequest): { status: string; created: boolean } {
    if (!/^[A-Za-z0-9:_\-./]{8,200}$/.test(key)) throw new HttpError(400, 'invalid_key', 'idempotencyKey must be 8-200 URL-safe characters')
    return tx(this.db, () => {
      const have = this.db.prepare('SELECT request_json, status FROM outbox WHERE idempotency_key = ?').get(key) as { request_json: string; status: string } | undefined
      const json = JSON.stringify(request)
      if (have) {
        if (have.request_json !== json) throw new HttpError(409, 'idempotency_conflict', 'this idempotency key was used with a different request')
        return { status: have.status, created: false }
      }
      const t = this.deps.now()
      this.db.prepare('INSERT INTO outbox (idempotency_key, owner_id, request_json, status, attempts, retry_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(key, ownerId, json, 'queued', t, t, t)
      return { status: 'queued', created: true }
    })
  }

  /** Run every entry that is due. Returns how many were attempted. */
  async dispatchDue(limit = 20): Promise<number> {
    const rows = this.db.prepare("SELECT idempotency_key, request_json, attempts FROM outbox WHERE status IN ('queued','retrying') AND (retry_at IS NULL OR retry_at <= ?) ORDER BY created_at LIMIT ?").all(this.deps.now(), limit) as { idempotency_key: string; request_json: string; attempts: number }[]
    for (const r of rows) await this.attempt(r.idempotency_key, JSON.parse(r.request_json) as WebhookRequest, r.attempts + 1)
    return rows.length
  }

  async attempt(key: string, request: WebhookRequest, attempt: number): Promise<Outcome> {
    // claim the entry so two dispatchers never send the same message at once
    const claimed = this.db.prepare("UPDATE outbox SET status = 'sending', attempts = ?, updated_at = ? WHERE idempotency_key = ? AND status IN ('queued','retrying')").run(attempt, this.deps.now(), key)
    if (!claimed.changes) return { state: 'failed', reason: 'already being sent' }
    const out = await executeWebhook(request, key, this.cfg, this.conns, this.deps, attempt)
    const t = this.deps.now()
    let status: string = out.state === 'retry' ? 'retrying' : out.state
    let retryAt: number | null = null
    if (out.state === 'retry') {
      if (attempt >= MAX_ATTEMPTS) status = 'failed'
      else retryAt = t + out.retryAfterMs
    }
    this.db.prepare('UPDATE outbox SET status = ?, retry_at = ?, result_json = ?, updated_at = ? WHERE idempotency_key = ?').run(status, retryAt, JSON.stringify(out), t, key)
    return out
  }

  get(key: string, ownerId: string) {
    return this.db.prepare('SELECT idempotency_key AS key, status, attempts, retry_at AS retryAt, result_json AS result FROM outbox WHERE idempotency_key = ? AND owner_id = ?').get(key, ownerId) as { key: string; status: string; attempts: number; retryAt: number | null; result: string | null } | undefined
  }
}
