// Composition: config + SQLite + routes -> an http.Server. Nothing here starts listening by itself; main.ts and the tests do.
import { createServer, type Server } from 'node:http'
import { openDb, type Db } from './db.ts'
import type { Config } from './config.ts'
import { HttpError, RateLimiter, Router, readBody, send, sendError, type Req } from './http.ts'
import { ensureOwner, randomToken, requireOwner } from './auth.ts'
import { publicationRoutes } from './publications.ts'
import { JobRunner, jobRoutes } from './jobs.ts'
import { providerRoutes } from './providers.ts'
import { Outbox, loadConnections, realDeps, type Connections, type Deps, type WebhookRequest } from './outbox.ts'

export interface Gateway {
  server: Server
  db: Db
  outbox: Outbox
  runner: JobRunner
  ownerToken: string
  /** begin background work (outbox dispatch + job ticks); returns a stop function */
  startBackground(everyMs?: number): () => void
  close(): Promise<void>
}

export interface Options {
  deps?: Deps
  connections?: Connections
  now?: () => number
  /** trust X-Forwarded-For from a reverse proxy for rate limiting (only behind your own proxy) */
  trustProxy?: boolean
}

export function createGateway(cfg: Config, opts: Options = {}): Gateway {
  const now = opts.now ?? Date.now
  const db = openDb(cfg.dbPath)
  let ownerToken = cfg.ownerToken
  if (!ownerToken) {
    if (!cfg.dev) throw new Error('GATEWAY_OWNER_TOKEN is required (set GATEWAY_DEV=1 on a loopback address for a throwaway development token)')
    ownerToken = randomToken(32)
  }
  ensureOwner(db, ownerToken)
  const deps = opts.deps ?? { ...realDeps, now }
  const outbox = new Outbox(db, cfg, opts.connections ?? loadConnections(cfg.connectionsFile), deps)
  const runner = new JobRunner(db, cfg, outbox, undefined, now)
  const limiter = new RateLimiter(cfg.ratePerMinute)
  const providers = providerRoutes(db, cfg, () => outbox.conns, deps.fetchImpl, now)
  const pubs = publicationRoutes(db, cfg, limiter, now)
  const jobs = jobRoutes(db, now)
  const router = new Router()

  router.add('GET', '/v1/health', () => ({ body: { ok: true } }))
  router.add('GET', '/v1/capabilities', () => ({
    body: {
      privatePublication: 'ready',
      publicForms: 'ready',
      jobs: 'ready',
      outbox: 'ready',
      sharedWorkspace: 'unsupported',
      identityProvider: 'needs_setup',
      note: 'Shared workspaces and OIDC sign-in are not implemented in this version; see README.',
    },
  }))
  // private publication
  router.add('POST', '/v1/publications', pubs.create)
  router.add('PUT', '/v1/publications/:id', pubs.update)
  router.add('DELETE', '/v1/publications/:id', pubs.revoke)
  router.add('GET', '/v1/publications/:id', pubs.status)
  router.add('GET', '/v1/forms/:publicId', pubs.form)
  router.add('POST', '/v1/forms/:publicId/submissions', pubs.submit)
  router.add('GET', '/v1/submissions/:receipt', pubs.receipt)
  router.add('GET', '/v1/inbox', pubs.inbox)
  router.add('POST', '/v1/inbox/:id/ack', pubs.ack)
  // jobs
  router.add('POST', '/v1/jobs', jobs.create)
  router.add('GET', '/v1/jobs/:id/runs', jobs.runs)
  router.add('POST', '/v1/jobs/:id/pause', jobs.pause)
  router.add('POST', '/v1/jobs/:id/touch', jobs.touch)
  // connected providers and imported sources (credentials stay on the gateway)
  router.add('POST', '/v1/providers/retrieve', providers.retrieve)
  router.add('POST', '/v1/providers/pull', providers.pull)
  // outbound messages
  router.add('POST', '/v1/outbox', async (req: Req) => {
    const owner = requireOwner(db, req)
    const b = req.body as { idempotencyKey?: string; request?: WebhookRequest } | undefined
    if (!b?.idempotencyKey || !b.request || b.request.type !== 'webhook' || typeof b.request.url !== 'string') throw new HttpError(400, 'invalid_outbox', 'send { idempotencyKey, request: { type: "webhook", url, body } }')
    const r = outbox.enqueue(owner, b.idempotencyKey, b.request)
    if (r.created) await outbox.dispatchDue(1)
    const row = outbox.get(b.idempotencyKey, owner)!
    return { status: r.created ? 202 : 200, body: { key: row.key, status: row.status, attempts: row.attempts, retryAt: row.retryAt, result: row.result ? JSON.parse(row.result) : null } }
  })
  router.add('GET', '/v1/outbox/:key', (req: Req) => {
    const owner = requireOwner(db, req)
    const row = outbox.get(req.params.key, owner)
    if (!row) throw new HttpError(404, 'not_found', 'message not found')
    return { body: { key: row.key, status: row.status, attempts: row.attempts, retryAt: row.retryAt, result: row.result ? JSON.parse(row.result) : null } }
  })
  // shared workspaces: answered honestly instead of pretending
  const unsupported = () => {
    throw new HttpError(501, 'unsupported', 'shared workspaces are not implemented in this gateway version')
  }
  for (const [m, p] of [['POST', '/v1/workspaces'], ['POST', '/v1/workspaces/:id/commands'], ['GET', '/v1/workspaces/:id/records'], ['GET', '/v1/workspaces/:id/changes'], ['GET', '/v1/workspaces/:id/events'], ['POST', '/v1/workspaces/:id/grants'], ['GET', '/v1/workspaces/:id/principals']] as const) router.add(m, p, unsupported)

  const server = createServer(async (rq, rs) => {
    try {
      const url = new URL(rq.url ?? '/', 'http://x')
      const m = router.match(rq.method ?? 'GET', url.pathname)
      if (!m) throw new HttpError(404, 'not_found', 'no such endpoint')
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
      const body = rq.method === 'GET' || rq.method === 'DELETE' ? undefined : await readBody(rq, cfg.maxBody)
      const fwd = opts.trustProxy ? String(rq.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
      const out = await m.handler({ method: rq.method ?? 'GET', path: url.pathname, query: url.searchParams, params: m.params, headers: rq.headers, ip: fwd || rq.socket.remoteAddress || '', body })
      send(rs, out.status ?? 200, out.body, out.headers)
    } catch (e) {
      sendError(rs, e)
    }
  })

  return {
    server, db, outbox, runner, ownerToken,
    startBackground(everyMs = 5000) {
      let busy = false
      const h = setInterval(() => {
        if (busy) return
        busy = true
        void (async () => { try { await outbox.dispatchDue(); await runner.tick() } catch (e) { console.error('background', e) } finally { busy = false } })()
      }, everyMs)
      h.unref()
      return () => clearInterval(h)
    },
    close: () => new Promise((res) => { server.close(() => { db.close(); res() }); server.closeAllConnections?.() }),
  }
}
