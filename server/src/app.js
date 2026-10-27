// HTTP API. Everything under /v1 except /health, /auth/challenge, /auth/register, /auth/login and /auth/recover
// needs `Authorization: Bearer <device token>`. Errors are `{ "error": "<code>", ... }` with a fitting status.

import Fastify from 'fastify'
import { DUMMY_HASH, Limiter, checkPow, hashPassword, makeChallenge, newId, newRecoveryKey, newToken, recoveryHash, safeEqualHex, sha256hex, verifyPassword } from './auth.js'
import { blobRow, receiveBlob, receivedBytes, usedBytes } from './blobs.js'
import { tx } from './db.js'
import { purgeVault } from './gc.js'
import { SYNC_ROOTS } from './paths.js'
import { Hub } from './hub.js'
import { blobKey } from './storage.js'
import { HttpError, changesSince, commit, createVault, listVaults, ownedVault, publicFile, renameVault, restoreRevision, revisionRow, revisionsOf, snapshotPage, stateOf, trashVault, untrashVault, vaultRow } from './vaults.js'

const MB = 1024 * 1024
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/
const HOUR = 3600 * 1000

const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : '')
const deviceName = (v) => str(v, 60).trim() || 'device'

export async function buildApp({ cfg, db, storage, hub = new Hub(), limiter = new Limiter(), onWrite = () => {}, logger = false, now = () => Date.now() }) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 2 * MB, connectionTimeout: 0, keepAliveTimeout: 65_000 })
  app.decorate('hub', hub)
  app.decorate('limiter', limiter)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 16 * MB }, (_req, body, done) => done(null, body))

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...err.extra })
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'too_large' : 'bad_request' })
    req.log.error({ err: err.message }, 'unhandled error')
    return reply.code(500).send({ error: 'internal' })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }))
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-noviq-api', String(cfg.api))
  })

  const tooMany = (reply, retry) => reply.header('retry-after', String(retry)).code(429).send({ error: 'rate_limited', retry })

  // ───── authentication of every request that is not public ─────
  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (req, reply) => {
    const api = Number(req.headers['x-noviq-api'] ?? 1)
    const discovery = ['/', '/v1/health', '/v1/auth/challenge'].includes(req.routeOptions.url)
    if ((!discovery || req.headers['x-noviq-api'] !== undefined) && (!Number.isInteger(api) || api < cfg.minApi)) return reply.code(426).send({ error: 'upgrade_required', min: cfg.minApi })
    if (req.routeOptions.config?.public) return
    const m = /^Bearer (nvq_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? '')
    const row = m
      ? db
          .prepare(
            `SELECT d.id AS device_id, d.name AS device_name, d.last_seen, u.id AS user_id, u.username, u.deleting
               FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
          )
          .get(sha256hex(m[1]))
      : null
    if (!row) return reply.code(401).send({ error: 'unauthorized' })
    if (row.deleting) throw new HttpError(409, 'account_deleting')
    const t = now()
    if (t - row.last_seen > 60_000) db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(t, row.device_id)
    const lim = limiter.hit(`t:${row.device_id}`, 1500, 60_000)
    if (!lim.ok) return tooMany(reply, lim.retry)
    req.auth = { user: { id: row.user_id, username: row.username }, device: { id: row.device_id, name: row.device_name } }
  })

  // Parsing an upload body can yield after authentication. Revocation that
  // completed in that interval must take effect before the operation starts.
  app.addHook('preHandler', async req => {
    if (!req.auth) return
    const row = db.prepare('SELECT d.revoked_at, u.deleting FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND u.id = ?').get(req.auth.device.id, req.auth.user.id)
    if (!row || row.revoked_at !== null) throw new HttpError(401, 'unauthorized')
    if (row.deleting) throw new HttpError(409, 'account_deleting')
  })

  const vaultOf = (req, opts) => ownedVault(db, req.auth.user.id, req.params.id, opts)

  // Password verification yields to other requests. Revalidate its snapshot at
  // the transaction boundary, including the calling device for protected work.
  const unchangedCredentials = (snapshot, req = null) => {
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(snapshot.id)
    if (!current || current.deleting) throw new HttpError(409, 'account_deleting')
    if (current.pass !== snapshot.pass || current.recovery !== snapshot.recovery) throw new HttpError(409, 'credentials_changed')
    if (req) {
      const device = db.prepare('SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?').get(req.auth.device.id, snapshot.id)
      if (!device || device.revoked_at !== null) throw new HttpError(401, 'unauthorized')
    }
    return current
  }

  // ───── public ─────
  const pub = { config: { public: true } }
  app.get('/', pub, async (_req, reply) => reply.type('text/plain').send('noviq-sync'))
  app.get('/v1/health', pub, async () => ({ ok: true, name: 'noviq-sync', api: cfg.api, min_api: cfg.minApi, capabilities: ['permanent_delete', 'database_sync', 'full_snapshot', 'session_safe_writes'], sync_roots: SYNC_ROOTS, registration: cfg.registration, pow_bits: cfg.powBits, server_time: now() }))

  app.get('/v1/auth/challenge', pub, async (req, reply) => {
    const lim = limiter.hit(`ch:${req.ip}`, 120, HOUR)
    if (!lim.ok) return tooMany(reply, lim.retry)
    return { challenge: makeChallenge(cfg.secret, now()), bits: cfg.powBits }
  })

  /** Consumes the proof of work of a request. Throws when it is missing, wrong, old or used before. */
  const takePow = (body) => {
    const r = checkPow(cfg.secret, body?.challenge, body?.counter, cfg.powBits, now())
    if (!r.ok) throw new HttpError(400, r.error)
    if (r.nonce) {
      try {
        db.prepare('INSERT INTO pow_used (nonce, at) VALUES (?, ?)').run(r.nonce, now())
      } catch {
        throw new HttpError(400, 'bad_pow')
      }
    }
  }

  const issueDevice = (userId, name) => {
    const token = newToken()
    const id = newId()
    const t = now()
    db.prepare('INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, name, sha256hex(token), t, t)
    return { token, device: { id, name } }
  }

  app.post('/v1/auth/register', pub, async (req, reply) => {
    const lim = limiter.hit(`reg:${req.ip}`, cfg.registerPerHour, HOUR)
    if (!lim.ok) return tooMany(reply, lim.retry)
    if (cfg.registration === 'closed') throw new HttpError(403, 'registration_closed')
    const b = req.body ?? {}
    const username = str(b.username, 40).trim().toLowerCase()
    const password = str(b.password, 200)
    if (!USERNAME.test(username)) throw new HttpError(400, 'bad_username')
    if (password.length < 8) throw new HttpError(400, 'weak_password')
    takePow(b)
    let code = ''
    if (cfg.registration === 'invite') {
      code = str(b.invite, 80).trim()
      if (!Object.hasOwn(cfg.inviteCodes, code)) throw new HttpError(403, 'bad_invite')
      const used = db.prepare('SELECT uses FROM invite_uses WHERE code = ?').get(code)?.uses ?? 0
      if (used >= cfg.inviteCodes[code]) throw new HttpError(403, 'invite_used')
    }
    const pass = await hashPassword(password)
    const recovery = newRecoveryKey()
    const id = newId()
    const out = tx(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'username_taken')
      db.prepare('INSERT INTO users (id, username, pass, recovery, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, pass, recoveryHash(recovery), now())
      if (code) db.prepare('INSERT INTO invite_uses (code, uses) VALUES (?, 1) ON CONFLICT (code) DO UPDATE SET uses = uses + 1').run(code)
      return issueDevice(id, deviceName(b.device_name))
    })
    return reply.code(201).send({ user: { id, username }, ...out, recovery_key: recovery })
  })

  /** Shared by login and recovery: counts failures per user name and per address and refuses once there are too many. */
  const guard = (req, username) => {
    const ipBlock = limiter.blocked(`fail:ip:${req.ip}`, 100)
    const userBlock = limiter.blocked(`fail:u:${username}`, 10)
    return Math.max(ipBlock, userBlock)
  }
  const failed = (req, username) => {
    limiter.hit(`fail:ip:${req.ip}`, 100, 15 * 60_000)
    limiter.hit(`fail:u:${username}`, 10, 15 * 60_000)
  }

  app.post('/v1/auth/login', pub, async (req, reply) => {
    const lim = limiter.hit(`login:${req.ip}`, 90, 60_000)
    if (!lim.ok) return tooMany(reply, lim.retry)
    const b = req.body ?? {}
    const username = str(b.username, 40).trim().toLowerCase()
    const password = str(b.password, 200)
    const wait = guard(req, username)
    if (wait) return tooMany(reply, wait)
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    const ok = await verifyPassword(password, user?.pass ?? DUMMY_HASH)
    if (!user || !ok) {
      failed(req, username)
      throw new HttpError(401, 'bad_credentials')
    }
    const current = unchangedCredentials(user)
    limiter.clear(`fail:u:${username}`)
    const restored = !!current.delete_after
    if (restored) db.prepare('UPDATE users SET delete_after = NULL WHERE id = ?').run(user.id)
    const out = issueDevice(user.id, deviceName(b.device_name))
    return { user: { id: user.id, username: user.username }, ...out, restored }
  })

  app.post('/v1/auth/recover', pub, async (req, reply) => {
    const b = req.body ?? {}
    const username = str(b.username, 40).trim().toLowerCase()
    const next = str(b.new_password, 200)
    const wait = guard(req, username)
    if (wait) return tooMany(reply, wait)
    if (next.length < 8) throw new HttpError(400, 'weak_password')
    takePow(b)
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    if (!user || !safeEqualHex(user.recovery, recoveryHash(b.recovery_key))) {
      failed(req, username)
      throw new HttpError(401, 'bad_recovery_key')
    }
    const pass = await hashPassword(next)
    const recovery = newRecoveryKey()
    const out = tx(db, () => {
      unchangedCredentials(user)
      db.prepare('UPDATE users SET pass = ?, recovery = ?, delete_after = NULL WHERE id = ?').run(pass, recoveryHash(recovery), user.id)
      db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), user.id)
      return issueDevice(user.id, deviceName(b.device_name))
    })
    limiter.clear(`fail:u:${username}`)
    return { user: { id: user.id, username: user.username }, ...out, recovery_key: recovery }
  })

  // ───── account and devices ─────
  app.post('/v1/auth/logout', async (req) => {
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), req.auth.device.id)
    return { ok: true }
  })

  app.get('/v1/account', async (req) => {
    const u = req.auth.user
    const devices = db
      .prepare('SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at')
      .all(u.id)
      .map((d) => ({ ...d, current: d.id === req.auth.device.id }))
    const created = db.prepare('SELECT created_at FROM users WHERE id = ?').get(u.id).created_at
    return { user: { ...u, created_at: created }, devices, quota: { used: usedBytes(db, u.id), limit: cfg.quotaBytes }, vaults: listVaults(db, u.id).length, server_time: now() }
  })

  app.post('/v1/auth/password', async (req, reply) => {
    const b = req.body ?? {}
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.user.id)
    if (!user || user.deleting) throw new HttpError(409, 'account_deleting')
    const next = str(b.new_password, 200)
    if (next.length < 8) throw new HttpError(400, 'weak_password')
    const wait = guard(req, user.username)
    if (wait) return tooMany(reply, wait)
    if (!(await verifyPassword(str(b.old_password, 200), user.pass))) {
      failed(req, user.username)
      throw new HttpError(401, 'bad_credentials')
    }
    const pass = await hashPassword(next)
    tx(db, () => {
      unchangedCredentials(user, req)
      db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(pass, user.id)
      db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').run(now(), user.id, req.auth.device.id)
    })
    return { ok: true }
  })

  app.post('/v1/auth/recovery-key', async (req, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.user.id)
    if (!user || user.deleting) throw new HttpError(409, 'account_deleting')
    const wait = guard(req, user.username)
    if (wait) return tooMany(reply, wait)
    if (!(await verifyPassword(str(req.body?.password, 200), user.pass))) {
      failed(req, user.username)
      throw new HttpError(401, 'bad_credentials')
    }
    const key = newRecoveryKey()
    tx(db, () => {
      unchangedCredentials(user, req)
      db.prepare('UPDATE users SET recovery = ? WHERE id = ?').run(recoveryHash(key), user.id)
    })
    return { recovery_key: key }
  })

  app.delete('/v1/devices/:id', async (req) => {
    const r = db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), req.params.id, req.auth.user.id)
    if (!r.changes) throw new HttpError(404, 'no_such_device')
    return { ok: true }
  })

  app.delete('/v1/account', async (req, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.user.id)
    if (!user || user.deleting) throw new HttpError(409, 'account_deleting')
    const wait = guard(req, user.username)
    if (wait) return tooMany(reply, wait)
    if (!(await verifyPassword(str(req.body?.password, 200), user.pass))) {
      failed(req, user.username)
      throw new HttpError(401, 'bad_credentials')
    }
    const after = now() + cfg.retentionDays * 24 * HOUR
    tx(db, () => {
      unchangedCredentials(user, req)
      db.prepare('UPDATE users SET delete_after = ? WHERE id = ?').run(after, user.id)
      db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), user.id)
    })
    return { ok: true, delete_after: after }
  })

  // ───── vaults ─────
  app.get('/v1/vaults', async (req) => ({ vaults: listVaults(db, req.auth.user.id, req.query?.trashed === '1') }))

  app.post('/v1/vaults', async (req, reply) => {
    const r = createVault(db, req.auth.user.id, { id: req.body?.id, name: req.body?.name }, cfg, now())
    if (r.created) onWrite()
    return reply.code(r.created ? 201 : 200).send(r)
  })

  app.patch('/v1/vaults/:id', async (req) => {
    renameVault(db, vaultOf(req), req.body?.name)
    onWrite()
    return { ok: true }
  })

  app.delete('/v1/vaults/:id', async (req) => {
    const v = vaultOf(req)
    trashVault(db, v, now())
    onWrite()
    hub.notify(v.id)
    return { ok: true }
  })

  /** Deletes a vault that is already in the trash for good, without waiting for the retention period. Not undoable. */
  app.delete('/v1/vaults/:id/permanent', async (req) => {
    // A retry after a lost success response is still a success. Never touch another owner's vault.
    const v = vaultRow(db, req.params.id)
    if (!v || v.user_id !== req.auth.user.id) return { ok: true }
    if (!v.deleted_at) throw new HttpError(409, 'not_in_trash')
    await purgeVault(db, storage, v.id)
    hub.notify(v.id)
    onWrite()
    return { ok: true }
  })

  app.post('/v1/vaults/:id/undelete', async (req) => {
    untrashVault(db, vaultOf(req, { deleted: true }))
    onWrite()
    return { ok: true }
  })

  // ───── sync ─────
  /** State of the vault; with `since` and `wait` it answers as soon as the vault moves past `since` (or after `wait` seconds). */
  app.get('/v1/vaults/:id/state', async (req, reply) => {
    let v = vaultOf(req)
    const since = Number.parseInt(String(req.query?.since ?? ''), 10)
    const wait = Math.min(Math.max(Number.parseInt(String(req.query?.wait ?? '0'), 10) || 0, 0), 30)
    if (Number.isInteger(since) && wait > 0 && v.seq <= since) {
      await hub.wait(v.id, wait * 1000, reply.raw)
      v = vaultRow(db, v.id)
      if (!v || v.deleted_at) throw new HttpError(404, 'no_such_vault')
    }
    return stateOf(db, v, now())
  })

  app.get('/v1/vaults/:id/snapshot', async (req) => snapshotPage(db, vaultOf(req), {
    after: str(req.query?.after, 300), epoch: req.query?.epoch,
    head: req.query?.head === undefined ? undefined : Number(req.query.head),
    limit: Number(req.query?.limit ?? 500),
  }, now()))

  app.get('/v1/vaults/:id/changes', async (req) => {
    const since = Number.parseInt(String(req.query?.since ?? '0'), 10)
    const limit = Number.parseInt(String(req.query?.limit ?? '500'), 10)
    return changesSince(db, vaultOf(req), since, limit, now())
  })

  /** One path as it is right now (a tombstone is answered as such; a path the server never saw is a 404). */
  app.get('/v1/vaults/:id/file', async (req) => {
    const v = vaultOf(req)
    const r = db.prepare('SELECT * FROM files WHERE vault_id = ? AND path = ?').get(v.id, str(req.query?.path, 300))
    if (!r) throw new HttpError(404, 'no_such_file')
    return { file: publicFile(r), server_time: now() }
  })

  app.get('/v1/vaults/:id/revisions', async (req) => ({ revisions: revisionsOf(db, vaultOf(req), str(req.query?.path, 300)) }))

  app.post('/v1/vaults/:id/commit', async (req) => {
    const v = vaultOf(req)
    const r = commit(db, v, req.auth.device.id, req.body, cfg, now())
    if (r.changed) {
      hub.notify(v.id)
      onWrite()
    }
    const { changed: _changed, ...body } = r
    return body
  })

  app.post('/v1/vaults/:id/restore', async (req) => {
    const v = vaultOf(req)
    const r = restoreRevision(db, v, req.auth.device.id, { path: str(req.body?.path, 300), rev: Number(req.body?.rev) }, now())
    if (r.changed) {
      hub.notify(v.id)
      onWrite()
    }
    const { changed: _changed, ...body } = r
    return body
  })

  // ───── blobs ─────
  const parseRange = (h) => {
    if (!h) return null
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(h))
    if (!m) throw new HttpError(400, 'bad_range')
    return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
  }

  app.put('/v1/vaults/:id/blobs/:sha', async (req, reply) => {
    const v = vaultOf(req)
    const r = await receiveBlob({ db, storage, cfg, user: req.auth.user, vault: v, sha: req.params.sha, range: parseRange(req.headers['content-range']), body: req.body, now: now() })
    if (r.complete) onWrite()
    return reply.code(r.complete ? (r.existed ? 200 : 201) : 202).send(r)
  })

  app.route({
    method: 'HEAD',
    url: '/v1/vaults/:id/blobs/:sha',
    handler: async (req, reply) => {
      const v = vaultOf(req)
      const b = blobRow(db, v.id, req.params.sha)
      if (b) return reply.header('x-size', String(b.size)).header('x-md5', b.md5).code(200).send()
      return reply.header('x-received', String(await receivedBytes(cfg, v.id, req.params.sha))).code(404).send()
    },
  })

  const sendBlob = async (reply, vaultId, sha) => {
    const b = blobRow(db, vaultId, sha)
    const body = b ? await storage.get(blobKey(vaultId, sha)) : null
    if (!b || !body) throw new HttpError(404, 'no_such_blob')
    return reply.type('application/octet-stream').header('content-length', String(b.size)).header('x-md5', b.md5).header('x-sha256', sha).send(body)
  }

  app.get('/v1/vaults/:id/blobs/:sha', async (req, reply) => sendBlob(reply, vaultOf(req).id, req.params.sha))

  /** The content of one revision (the one the client was told about in `changes`), even if the path has moved on since. */
  app.get('/v1/vaults/:id/rev/:rev', async (req, reply) => {
    const v = vaultOf(req)
    const r = revisionRow(db, v.id, Number(req.params.rev))
    if (!r || r.deleted || !r.sha256) throw new HttpError(404, 'no_such_revision')
    return sendBlob(reply, v.id, r.sha256)
  })

  return app
}
