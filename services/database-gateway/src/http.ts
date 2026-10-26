// A very small router on node:http: JSON in, JSON out, hard body limit, structured errors. No framework so the service stays easy to audit.
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  code: string
  details?: unknown
  headers?: Record<string, string>
  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.headers = headers
  }
}

export interface Req {
  method: string
  path: string
  query: URLSearchParams
  params: Record<string, string>
  headers: IncomingMessage['headers']
  ip: string
  body: unknown
}
export type Handler = (req: Req) => Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }> | { status?: number; body?: unknown; headers?: Record<string, string> }

interface Route {
  method: string
  parts: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []
  add(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler })
  }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean)
    let pathMatched = false
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < parts.length && ok; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i])
        else ok = r.parts[i] === parts[i]
      }
      if (!ok) continue
      pathMatched = true
      if (r.method === method) return { handler: r.handler, params }
    }
    return pathMatched ? 'method' : null
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const len = Number(req.headers['content-length'] ?? 0)
  if (len > limit) throw new HttpError(413, 'body_too_large', `the request body may be at most ${limit} bytes`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new HttpError(413, 'body_too_large', `the request body may be at most ${limit} bytes`)
    chunks.push(c as Buffer)
  }
  if (!size) return undefined
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'send application/json')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'the body is not valid JSON')
  }
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(data)
}

export const sendError = (res: ServerResponse, e: unknown) => {
  if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } }, e.headers)
  console.error('gateway error', e)
  send(res, 500, { error: { code: 'internal', message: 'something went wrong' } })
}

/** Fixed-window limiter per key. Memory only: a restart resets it, which is fine for abuse control on a single instance. */
export class RateLimiter {
  private hits = new Map<string, { n: number; start: number }>()
  perMinute: number
  constructor(perMinute: number) {
    this.perMinute = perMinute
  }
  check(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    const h = this.hits.get(key)
    if (!h || now - h.start >= 60_000) {
      this.hits.set(key, { n: 1, start: now })
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (now - v.start >= 60_000) this.hits.delete(k)
      return { ok: true }
    }
    h.n++
    return h.n <= this.perMinute ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - h.start)) / 1000)) }
  }
}
