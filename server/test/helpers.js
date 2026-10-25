import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import { solvePow } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import { Hub } from '../src/hub.js'
import { MemStorage } from '../src/storage.js'

export const sha = (s) => createHash('sha256').update(s).digest('hex')
export const md5 = (s) => createHash('md5').update(s).digest('hex')

/** A server on an in-memory database and storage; `clock.t` is the time it believes it is. */
export async function setup(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'noviq-test-'))
  const clock = { t: 1_700_000_000_000 }
  const cfg = { ...loadConfig({}), dataDir: dir, secret: 'k'.repeat(40), registration: 'open', powBits: 4, storage: 'memory', ...over }
  const db = openDb(':memory:')
  const storage = new MemStorage()
  const hub = new Hub()
  const writes = { n: 0 }
  const app = await buildApp({ cfg, db, storage, hub, now: () => clock.t, onWrite: () => writes.n++ })
  await app.ready()
  return {
    app,
    db,
    storage,
    cfg,
    hub,
    clock,
    writes,
    dir,
    async close() {
      hub.releaseAll()
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Calls the API in-process. Returns `{ status, body, headers, raw }`. */
export async function call(s, method, url, { token, body, headers = {}, ip } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  let payload
  if (Buffer.isBuffer(body)) {
    payload = body
    h['content-type'] ??= 'application/octet-stream'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    h['content-type'] = 'application/json'
  }
  const r = await s.app.inject({ method, url, headers: h, payload, remoteAddress: ip })
  let json
  try {
    json = JSON.parse(r.body)
  } catch {
    json = undefined
  }
  return { status: r.statusCode, body: json, headers: r.headers, raw: r.rawPayload }
}

export async function pow(s) {
  const { body } = await call(s, 'GET', '/v1/auth/challenge')
  return { challenge: body.challenge, counter: solvePow(body.challenge, body.bits) }
}

export async function register(s, username = 'alice', password = 'correct horse battery', extra = {}) {
  const r = await call(s, 'POST', '/v1/auth/register', { body: { username, password, device_name: 'laptop', ...(await pow(s)), ...extra } })
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`)
  return { token: r.body.token, deviceId: r.body.device.id, userId: r.body.user.id, recovery: r.body.recovery_key, username }
}

export async function login(s, username, password, device_name = 'phone') {
  return call(s, 'POST', '/v1/auth/login', { body: { username, password, device_name } })
}

export async function newVault(s, token, name = 'notes', id = crypto.randomUUID()) {
  const r = await call(s, 'POST', '/v1/vaults', { token, body: { id, name } })
  if (r.status !== 201) throw new Error(`vault failed: ${r.status} ${JSON.stringify(r.body)}`)
  return id
}

export async function putBlob(s, token, vault, content) {
  const buf = Buffer.from(content)
  const r = await call(s, 'PUT', `/v1/vaults/${vault}/blobs/${sha(buf)}`, { token, body: buf })
  if (r.status !== 201 && r.status !== 200) throw new Error(`blob failed: ${r.status} ${JSON.stringify(r.body)}`)
  return sha(buf)
}

let n = 0
/** One commit of puts/deletes; blobs are uploaded first. `ops` items: `{ put: [path, content, base] }` or `{ del: [path, base] }`. */
export async function commit(s, token, vault, ops, extra = {}) {
  const list = []
  for (const o of ops) {
    if (o.put) {
      const [path, content, base = 0] = o.put
      list.push({ op: 'put', path, sha256: await putBlob(s, token, vault, content), base_rev: base })
    } else {
      const [path, base] = o.del
      list.push({ op: 'delete', path, base_rev: base })
    }
  }
  return call(s, 'POST', `/v1/vaults/${vault}/commit`, { token, body: { op_id: `op-${++n}-${Math.random().toString(36).slice(2)}`, ops: list, ...extra } })
}

export const changes = (s, token, vault, since = 0, limit = 500) => call(s, 'GET', `/v1/vaults/${vault}/changes?since=${since}&limit=${limit}`, { token })
