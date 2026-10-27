// `node scripts/smoke.mjs <server url> [invite code]`: a real client's day against a running server, over HTTP.
// Registers a throw-away account, uploads and commits files, pulls them as a second device would, waits for
// a change by long poll and measures how long a change takes to arrive. Prints one line per step.
import { createHash } from 'node:crypto'
import { solvePow } from '../src/auth.js'

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const invite = process.argv[3]
const sha = (s) => createHash('sha256').update(s).digest('hex')
const api = async (method, path, { token, body, raw, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-noviq-api': '2', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}
const step = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exit(1)
}

const health = await api('GET', '/v1/health')
step('health', health.status === 200 && health.json?.ok, `registration=${health.json?.registration}, pow=${health.json?.pow_bits} bits`)

const ch = (await api('GET', '/v1/auth/challenge')).json
const t0 = Date.now()
const counter = solvePow(ch.challenge, ch.bits)
const user = `smoke${Date.now().toString(36)}`
const reg = await api('POST', '/v1/auth/register', { body: { username: user, password: 'smoke test password', invite, device_name: 'smoke-A', challenge: ch.challenge, counter } })
step('register', reg.status === 201, `${reg.json?.error ?? user}, proof of work took ${Date.now() - t0} ms`)
const A = reg.json.token

const login = await api('POST', '/v1/auth/login', { body: { username: user, password: 'smoke test password', device_name: 'smoke-B' } })
step('login on a second device', login.status === 200)
const B = login.json.token

const vault = crypto.randomUUID()
step('create vault', (await api('POST', '/v1/vaults', { token: A, body: { id: vault, name: 'Smoke' } })).status === 201)

const upload = async (token, content) => (await api('PUT', `/v1/vaults/${vault}/blobs/${sha(content)}`, { token, raw: Buffer.from(content) })).status
const commit = async (token, ops) => (await api('POST', `/v1/vaults/${vault}/commit`, { token, body: { op_id: `smoke-${Math.random().toString(36).slice(2)}`, ops } })).json

step('upload blob', (await upload(A, 'first page')) === 201)
const c1 = await commit(A, [{ op: 'put', path: 'pages/one.json', sha256: sha('first page'), base_rev: 0 }])
step('commit', c1.results[0].ok === true, `rev ${c1.results[0].rev}`)

const pulled = (await api('GET', `/v1/vaults/${vault}/changes?since=0`, { token: B })).json
step('second device sees it', pulled.files.length === 1 && pulled.files[0].path === 'pages/one.json')
const got = await api('GET', `/v1/vaults/${vault}/rev/${pulled.files[0].rev}`, { token: B })
step('second device downloads it', got.text === 'first page')

// the instant part: B is waiting when A saves
const waiting = (async () => {
  const t = Date.now()
  const r = await api('GET', `/v1/vaults/${vault}/state?since=${pulled.head}&wait=20`, { token: B })
  return { ms: Date.now() - t, seq: r.json.seq }
})()
await new Promise((r) => setTimeout(r, 300))
const sent = Date.now()
await upload(A, 'second page')
await commit(A, [{ op: 'put', path: 'pages/two.json', sha256: sha('second page'), base_rev: 0 }])
const w = await waiting
step('the waiting device is told at once', w.seq > pulled.head && Date.now() - sent < 3000, `${Date.now() - sent} ms from save to notice`)

await upload(B, 'an edit from a stale base')
const stale = await commit(B, [{ op: 'put', path: 'pages/one.json', sha256: sha('an edit from a stale base'), base_rev: 99 }])
step('a stale write is refused, not applied', stale.results[0].ok === false)

await api('POST', '/v1/auth/logout', { token: B })
step('a logged out device is refused', (await api('GET', `/v1/vaults/${vault}/state`, { token: B })).status === 401)
step('cleanup: vault to trash', (await api('DELETE', `/v1/vaults/${vault}`, { token: A })).status === 200)
console.log('all good')
