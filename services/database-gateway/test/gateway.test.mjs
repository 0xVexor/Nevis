// Gateway behaviour over real HTTP on an ephemeral port, SQLite in memory, injected clock / fetch / DNS (handoff §24-25, §21).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createGateway } = await import('../src/server.ts')
const { loadConfig } = await import('../src/config.ts')
const { checkTarget, isPrivateAddress, BACKOFF_MS } = await import('../src/outbox.ts')
const { occurrences } = await import('../src/jobs.ts')

const OWNER = 'o'.repeat(40)
const clock = { t: Date.parse('2026-10-25T08:00:00Z') }
const open = []
process.on('exit', () => { for (const s of open) try { s.close() } catch { /* already closed */ } })

async function start(over = {}, opts = {}) {
  const cfg = { ...loadConfig({ GATEWAY_OWNER_TOKEN: OWNER, GATEWAY_DB: ':memory:', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', ...over }) }
  const sent = []
  const behavior = { next: () => new Response('ok', { status: 200 }) }
  const gw = createGateway(cfg, {
    now: () => clock.t,
    deps: { now: () => clock.t, resolve: async (h) => (h === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']), fetchImpl: async (url, init) => { sent.push({ url: String(url), init }); return behavior.next(sent.length) } },
    ...opts,
  })
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r))
  open.push(gw.server)
  const base = `http://127.0.0.1:${gw.server.address().port}`
  const call = async (method, path, body, token = OWNER, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
  return { gw, call, sent, behavior, close: () => gw.close() }
}

const form = (over = {}) => ({
  title: 'Bug report',
  form: {
    version: 1, open: true, anonymous: false, submitMessage: 'Thanks!',
    questions: [
      { id: 'q1', propertyId: 'pt', title: 'What happened?', description: '', syncLabel: true, required: true, order: 0 },
      { id: 'q2', propertyId: 'ps', title: 'Severity', description: '', syncLabel: true, required: false, order: 1 },
    ],
    ...over,
  },
  properties: [
    { id: 'pt', kind: 'title', name: 'Name', config: {} },
    { id: 'ps', kind: 'select', name: 'Severity', config: { options: [{ id: 'o1', name: 'Low', color: 'green', sortKey: 'V' }, { id: 'o2', name: 'High', color: 'red', sortKey: 'k' }] } },
    { id: 'secret', kind: 'text', name: 'Internal notes', config: {} }, // never asked: must not be published
  ],
})
const sub = (id, answers, v) => ({ submissionId: id, formVersion: v, answers })

test('owner endpoints need the owner token; public endpoints do not', async () => {
  const s = await start()
  assert.equal((await s.call('POST', '/v1/publications', form(), null)).status, 401)
  assert.equal((await s.call('POST', '/v1/publications', form(), 'x'.repeat(40))).status, 401)
  assert.equal((await s.call('GET', '/v1/health', undefined, null)).status, 200)
  await s.close()
})

test('publishing keeps only asked properties and the public view never exposes the schema', async () => {
  const s = await start()
  const pub = await s.call('POST', '/v1/publications', form())
  assert.equal(pub.status, 201)
  assert.match(pub.body.url, /\/v1\/forms\/[A-Za-z0-9_-]{20,}$/)
  const v = await s.call('GET', `/v1/forms/${pub.body.publicId}`, undefined, null)
  assert.equal(v.status, 200)
  const text = JSON.stringify(v.body)
  assert.ok(!text.includes('secret') && !text.includes('Internal notes'))
  assert.deepEqual(v.body.questions[1].options.map((o) => o.name), ['Low', 'High'])
  assert.equal(v.body.questions[0].kind, 'title')
  await s.close()
})

test('invalid publications are rejected: unpublished property, broken branching', async () => {
  const s = await start()
  const bad = form()
  bad.form.questions[1].propertyId = 'nope'
  assert.equal((await s.call('POST', '/v1/publications', bad)).status, 422)
  const cyc = form()
  cyc.form.questions[0].visibleWhen = { questionId: 'q2', op: 'is_not_empty' }
  cyc.form.questions[1].visibleWhen = { questionId: 'q1', op: 'is_not_empty' }
  assert.equal((await s.call('POST', '/v1/publications', cyc)).status, 422)
  await s.close()
})

test('file questions are refused at publication: public uploads are not supported', async () => {
  const s = await start()
  const f = form()
  f.properties.push({ id: 'pf', kind: 'files', name: 'Attachment', config: {} })
  f.form.questions.push({ id: 'q3', propertyId: 'pf', title: 'File', description: '', syncLabel: true, required: false, order: 2 })
  const r = await s.call('POST', '/v1/publications', f)
  assert.equal(r.status, 422)
  assert.equal(r.body.error.code, 'unsupported_question')
  await s.close()
})

test('submissions are validated server-side with the shared validator', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form())
  const url = `/v1/forms/${p.publicId}/submissions`
  const missing = await s.call('POST', url, sub('sub-00000001', {}), null)
  assert.equal(missing.status, 422)
  assert.equal(missing.body.error.details.errors[0].questionId, 'q1')
  assert.equal((await s.call('POST', url, sub('sub-00000002', { q1: 'x', q2: 'not-an-option' }), null)).status, 422)
  assert.equal((await s.call('POST', url, sub('sub-00000003', { q1: 'x', bogus: 1 }), null)).status, 422) // unknown question id
  const ok = await s.call('POST', url, sub('sub-00000004', { q1: 'It broke', q2: 'o2' }), null)
  assert.equal(ok.status, 201)
  assert.equal(ok.body.status, 'pending_import') // never "saved" before the owner's app acknowledges
  assert.equal(ok.body.message, 'Thanks!')
  await s.close()
})

test('same submission id + same content returns the same receipt; different content conflicts', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form())
  const url = `/v1/forms/${p.publicId}/submissions`
  const a = await s.call('POST', url, sub('sub-aaaaaaaa', { q1: 'one' }), null)
  const b = await s.call('POST', url, sub('sub-aaaaaaaa', { q1: 'one' }), null)
  assert.equal(b.status, 200)
  assert.equal(b.body.receipt, a.body.receipt)
  assert.equal(b.body.repeated, true)
  assert.equal((await s.call('POST', url, sub('sub-aaaaaaaa', { q1: 'two' }), null)).status, 409)
  await s.close()
})

test('inbox: lease, apply, idempotent ack, rejection kept; receipt reflects status without answers', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form())
  const url = `/v1/forms/${p.publicId}/submissions`
  const r1 = (await s.call('POST', url, sub('sub-11111111', { q1: 'first' }), null)).body.receipt
  await s.call('POST', url, sub('sub-22222222', { q1: 'second' }), null)
  const inbox = await s.call('GET', '/v1/inbox')
  assert.equal(inbox.body.items.length, 2)
  assert.deepEqual(inbox.body.items.map((i) => i.answers.q1), ['first', 'second'])
  assert.equal((await s.call('GET', '/v1/inbox')).body.items.length, 0) // leased: not handed out twice
  clock.t += 61_000
  const again = await s.call('GET', '/v1/inbox')
  assert.equal(again.body.items.length, 2) // lease expired (the app crashed before acknowledging): redelivered
  const [i1, i2] = again.body.items
  assert.equal((await s.call('POST', `/v1/inbox/${i1.id}/ack`, { ackToken: 'wrong', result: { ok: true } })).status, 403)
  const ack = await s.call('POST', `/v1/inbox/${i1.id}/ack`, { ackToken: i1.ackToken, result: { ok: true, operationId: 'op-1', pageId: 'row-1' } })
  assert.equal(ack.body.status, 'applied')
  const ack2 = await s.call('POST', `/v1/inbox/${i1.id}/ack`, { ackToken: i1.ackToken, result: { ok: true, operationId: 'op-1', pageId: 'row-1' } })
  assert.equal(ack2.body.repeated, true)
  assert.equal((await s.call('POST', `/v1/inbox/${i1.id}/ack`, { ackToken: i1.ackToken, result: { ok: false, reason: 'x' } })).status, 409)
  await s.call('POST', `/v1/inbox/${i2.id}/ack`, { ackToken: i2.ackToken, result: { ok: false, reason: 'schema changed' } })
  const rc = await s.call('GET', `/v1/submissions/${r1}`, undefined, null)
  assert.equal(rc.body.status, 'applied')
  assert.ok(!JSON.stringify(rc.body).includes('first'))
  const st = await s.call('GET', `/v1/publications/${p.id}`)
  assert.deepEqual(st.body.submissions, { applied: 1, rejected: 1 })
  assert.equal((await s.call('GET', `/v1/submissions/nonexistent`, undefined, null)).status, 404) // receipts cannot be enumerated
  await s.close()
})

test('stale versions: accepted for 7 days by stable ids, then refresh_required; newer than current is refused', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form())
  const next = form(); next.form.questions[1].required = true
  assert.equal((await s.call('PUT', `/v1/publications/${p.id}`, { ...next, expectedVersion: 5 })).status, 409)
  assert.equal((await s.call('PUT', `/v1/publications/${p.id}`, { ...next, expectedVersion: 1 })).body.version, 2)
  const url = `/v1/forms/${p.publicId}/submissions`
  assert.equal((await s.call('POST', url, sub('sub-st000001', { q1: 'old form' }, 1), null)).status, 201) // still valid against v1 (q2 optional there)
  assert.equal((await s.call('POST', url, sub('sub-st000002', { q1: 'new form' }, 2), null)).status, 422) // v2 requires severity
  assert.equal((await s.call('POST', url, sub('sub-st000003', { q1: 'x' }, 3), null)).status, 400)
  clock.t += 8 * 24 * 3600_000
  const old = await s.call('POST', url, sub('sub-st000004', { q1: 'late' }, 1), null)
  assert.equal(old.status, 409)
  assert.equal(old.body.error.code, 'refresh_required')
  await s.close()
})

test('revoke: 410 for the form and for submissions; audit and stored submissions are kept', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form())
  const url = `/v1/forms/${p.publicId}/submissions`
  await s.call('POST', url, sub('sub-rv000001', { q1: 'x' }), null)
  assert.equal((await s.call('DELETE', `/v1/publications/${p.id}`)).status, 200)
  assert.equal((await s.call('GET', `/v1/forms/${p.publicId}`, undefined, null)).status, 410)
  assert.equal((await s.call('POST', url, sub('sub-rv000002', { q1: 'y' }), null)).status, 410)
  assert.equal((await s.call('GET', '/v1/inbox')).body.items.length, 1)
  assert.ok(s.gw.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'publication.revoke'").get().n === 1)
  await s.close()
})

test('closed forms, response limits, body size and rate limiting', async () => {
  const s = await start({ GATEWAY_RATE_PER_MINUTE: '4', GATEWAY_MAX_BODY: '2048' })
  const { body: closed } = await s.call('POST', '/v1/publications', form({ open: false }))
  assert.equal((await s.call('POST', `/v1/forms/${closed.publicId}/submissions`, sub('sub-cl000001', { q1: 'x' }), null)).status, 403)
  const { body: lim } = await s.call('POST', '/v1/publications', form({ limit: 1 }))
  assert.equal((await s.call('POST', `/v1/forms/${lim.publicId}/submissions`, sub('sub-lm000001', { q1: 'x' }), null)).status, 201)
  assert.equal((await s.call('POST', `/v1/forms/${lim.publicId}/submissions`, sub('sub-lm000002', { q1: 'y' }), null)).error?.code ?? (await s.call('POST', `/v1/forms/${lim.publicId}/submissions`, sub('sub-lm000003', { q1: 'z' }), null)).body.error.code, 'limit_reached')
  const big = await s.call('POST', `/v1/forms/${closed.publicId}/submissions`, sub('sub-big00001', { q1: 'x'.repeat(5000) }), null)
  assert.equal(big.status, 413)
  // 4 requests per minute per form and client
  const { body: rl } = await s.call('POST', '/v1/publications', form())
  const codes = []
  for (let i = 0; i < 6; i++) codes.push((await s.call('POST', `/v1/forms/${rl.publicId}/submissions`, sub(`sub-rl00000${i}`, { q1: 'x' }), null)).status)
  assert.deepEqual(codes.slice(0, 4), [201, 201, 201, 201])
  assert.deepEqual(codes.slice(4), [429, 429])
  await s.close()
})

test('anonymous forms store nothing about the respondent', async () => {
  const s = await start()
  const { body: p } = await s.call('POST', '/v1/publications', form({ anonymous: true }))
  const r = await s.call('POST', `/v1/forms/${p.publicId}/submissions`, sub('sub-an000001', { q1: 'x' }), null, { 'user-agent': 'secret-agent' })
  const cols = s.gw.db.prepare('PRAGMA table_info(submissions)').all().map((c) => c.name)
  assert.ok(!cols.some((c) => /(^|_)(ip|agent|email|user)/.test(c)))
  assert.ok(!JSON.stringify(r.body).includes('secret-agent'))
  await s.close()
})

test('shared workspaces and identity are reported as not implemented, never faked', async () => {
  const s = await start()
  assert.equal((await s.call('POST', '/v1/workspaces', {})).status, 501)
  assert.equal((await s.call('GET', '/v1/workspaces/w/changes')).status, 501)
  const cap = await s.call('GET', '/v1/capabilities', undefined, null)
  assert.equal(cap.body.sharedWorkspace, 'unsupported')
  assert.equal(cap.body.identityProvider, 'needs_setup')
  await s.close()
})

test('configuration: owner token length, dev only on loopback, token required unless dev', () => {
  assert.throws(() => loadConfig({ GATEWAY_OWNER_TOKEN: 'short' }), /32/)
  assert.throws(() => loadConfig({ GATEWAY_DEV: '1', GATEWAY_HOST: '0.0.0.0' }), /loopback/)
  assert.throws(() => createGateway(loadConfig({ GATEWAY_DB: ':memory:' })), /GATEWAY_OWNER_TOKEN is required/)
  const gw = createGateway(loadConfig({ GATEWAY_DB: ':memory:', GATEWAY_DEV: '1' }))
  assert.ok(gw.ownerToken.length >= 32)
  gw.db.close()
})

test('SSRF guard: https only, no private networks, allowlist, no credentials in the url', async () => {
  const cfg = { dev: false, webhookAllowlist: [] }
  const pub = async () => ['93.184.216.34']
  await checkTarget('https://hooks.example.com/x', cfg, pub)
  for (const bad of ['http://hooks.example.com/x', 'https://u:p@hooks.example.com/', 'ftp://x/']) await assert.rejects(() => checkTarget(bad, cfg, pub))
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.16.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip)
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip)
  await assert.rejects(() => checkTarget('https://internal.example.com/', cfg, async () => ['10.0.0.5']), /private network/)
  await assert.rejects(() => checkTarget('https://169.254.169.254/latest', cfg, pub), /private network/)
  await assert.rejects(() => checkTarget('https://other.test/', { dev: false, webhookAllowlist: ['example.com'] }, pub), /allowlist/)
  await checkTarget('https://a.example.com/', { dev: false, webhookAllowlist: ['example.com'] }, pub)
  await assert.rejects(() => checkTarget('http://localhost:9/', { dev: false, webhookAllowlist: [] }, pub), /https/)
  await checkTarget('http://localhost:9/', { dev: true, webhookAllowlist: [] }, pub)
})

test('outbox: delivers once per key, retries 5xx/429 with backoff and Retry-After, holds uncertain outcomes', async () => {
  const s = await start()
  const req = { idempotencyKey: 'msg-0000001', request: { type: 'webhook', url: 'https://hooks.example.com/a', body: { hi: 1 } } }
  s.behavior.next = () => new Response('', { status: 200 })
  const a = await s.call('POST', '/v1/outbox', req)
  assert.equal(a.body.status, 'succeeded')
  assert.equal(s.sent[0].init.headers['idempotency-key'], 'msg-0000001')
  assert.equal(s.sent[0].init.redirect, 'manual')
  const b = await s.call('POST', '/v1/outbox', req)
  assert.equal(b.status, 200)
  assert.equal(s.sent.length, 1) // same key + same request: not sent again
  assert.equal((await s.call('POST', '/v1/outbox', { ...req, request: { ...req.request, body: { hi: 2 } } })).status, 409)

  s.behavior.next = () => new Response('', { status: 429, headers: { 'retry-after': '7' } })
  const r = await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-0000002', request: { type: 'webhook', url: 'https://hooks.example.com/b' } })
  assert.equal(r.body.status, 'retrying')
  assert.equal(r.body.retryAt, clock.t + 7000)
  assert.equal(await s.gw.outbox.dispatchDue(), 0) // not yet due
  clock.t += 7000
  s.behavior.next = () => new Response('', { status: 200 })
  assert.equal(await s.gw.outbox.dispatchDue(), 1)
  assert.equal((await s.call('GET', '/v1/outbox/msg-0000002')).body.status, 'succeeded')

  s.behavior.next = () => { throw Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }) }
  const u = await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-0000003', request: { type: 'webhook', url: 'https://hooks.example.com/c' } })
  assert.equal(u.body.status, 'needs_review') // might have been delivered: never blindly resent
  s.behavior.next = () => new Response('', { status: 401 })
  const c = await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-0000004', request: { type: 'webhook', url: 'https://hooks.example.com/d' } })
  assert.equal(c.body.status, 'failed')
  assert.match(c.body.result.reason, /MISSING_CREDENTIALS/)
  const priv = await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-0000005', request: { type: 'webhook', url: 'https://internal.example.com/x' } })
  assert.equal(priv.body.status, 'failed')
  assert.equal(s.sent.filter((x) => x.url.includes('internal')).length, 0)
  assert.deepEqual(BACKOFF_MS, [1000, 5000, 30000, 300000])
  await s.close()
})

test('outbox: five failed attempts end as failed; connection secrets come from the gateway only', async () => {
  const s = await start({}, { connections: { c1: { headers: { authorization: 'Bearer from-gateway' } } } })
  s.behavior.next = () => new Response('', { status: 503 })
  await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-retry-001', request: { type: 'webhook', url: 'https://hooks.example.com/r', connectionId: 'c1' } })
  assert.equal(s.sent[0].init.headers.authorization, 'Bearer from-gateway')
  for (let i = 0; i < 6; i++) { clock.t += 400_000; await s.gw.outbox.dispatchDue() }
  const row = (await s.call('GET', '/v1/outbox/msg-retry-001')).body
  assert.equal(row.status, 'failed')
  assert.equal(row.attempts, 5)
  const missing = await s.call('POST', '/v1/outbox', { idempotencyKey: 'msg-conn-0001', request: { type: 'webhook', url: 'https://hooks.example.com/r', connectionId: 'unknown' } })
  assert.match(missing.body.result.reason, /MISSING_CREDENTIALS/)
  await s.close()
})

test('occurrences: interval and daily schedules follow the zone wall clock', () => {
  const t0 = Date.parse('2026-10-25T00:00:00Z')
  assert.equal(occurrences({ kind: 'every', minutes: 60 }, 'UTC', t0, t0 + 3 * 3600_000).length, 3)
  const d = occurrences({ kind: 'daily', at: '09:00' }, 'Asia/Tehran', t0, t0 + 3 * 24 * 3600_000)
  assert.deepEqual(d.map((x) => new Date(x).toISOString()), ['2026-10-25T05:30:00.000Z', '2026-10-26T05:30:00.000Z', '2026-10-27T05:30:00.000Z'])
  // DST: 09:00 in New York is 13:00Z before the change (2026-11-01) and 14:00Z after it
  const ny = occurrences({ kind: 'daily', at: '09:00' }, 'America/New_York', Date.parse('2026-10-31T00:00:00Z'), Date.parse('2026-11-02T23:00:00Z'))
  assert.deepEqual(ny.map((x) => new Date(x).toISOString()), ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'])
})

test('jobs: one run per occurrence, one catch-up after downtime, lease takeover, pause, stale context pauses', async () => {
  clock.t = Date.parse('2026-10-25T08:00:00Z')
  const s = await start()
  const job = await s.call('POST', '/v1/jobs', { timeZone: 'UTC', contextPublishedAt: clock.t, definition: { schedule: { kind: 'every', minutes: 60 }, action: { type: 'webhook', url: 'https://hooks.example.com/job', body: { n: 1 } } } })
  assert.equal(job.status, 201)
  assert.equal((await s.call('POST', '/v1/jobs', { timeZone: 'Mars/Base', definition: {} })).status, 422)
  clock.t = Date.parse('2026-10-25T09:00:30Z')
  await s.gw.runner.tick()
  await s.gw.runner.tick() // the same occurrence is not run twice
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].init.headers['idempotency-key'], `${job.body.id}:2026-10-25T09:00Z`)
  // the machine was off for five hours: one catch-up run, not five
  clock.t = Date.parse('2026-10-25T14:10:00Z')
  await s.gw.runner.tick()
  assert.equal(s.sent.length, 2)
  const runs = (await s.call('GET', `/v1/jobs/${job.body.id}/runs`)).body.runs
  assert.deepEqual(runs.map((r) => r.status), ['succeeded', 'succeeded'])
  // a second runner cannot take a live lease, but takes over an expired one
  const { JobRunner } = await import('../src/jobs.ts')
  const other = new JobRunner(s.gw.db, s.gw.runner.cfg, s.gw.outbox, 'runner-2', () => clock.t)
  const occ = `${job.body.id}:2026-10-25T15:00Z`
  s.gw.db.prepare("INSERT INTO leases (domain, key, holder, expires_at) VALUES ('job', ?, 'crashed', ?)").run(occ, clock.t + 30_000)
  assert.equal(other.lease(occ), false)
  clock.t += 31_000
  assert.equal(other.lease(occ), true)
  await s.call('POST', `/v1/jobs/${job.body.id}/pause`)
  clock.t = Date.parse('2026-10-25T20:00:00Z')
  await s.gw.runner.tick()
  assert.equal(s.sent.length, 2) // paused: no new occurrences
  const stale = await s.call('POST', '/v1/jobs', { timeZone: 'UTC', contextPublishedAt: clock.t - 10 * 60_000, definition: { requiresFresh: true, schedule: { kind: 'every', minutes: 1 }, action: { type: 'webhook', url: 'https://hooks.example.com/s' } } })
  clock.t += 120_000
  await s.gw.runner.tick()
  const sr = (await s.call('GET', `/v1/jobs/${stale.body.id}/runs`)).body.runs
  assert.equal(sr[0].status, 'paused_stale')
  assert.equal(s.sent.length, 2) // nothing sent on stale published values
  await s.close()
})

test('providers: credentials stay on the gateway; failures answer 424 with the provider code; sources pull completely', async () => {
  const s = await start({}, { connections: { work: { token: 'gh-secret' } } })
  s.behavior.next = (n) => new Response(JSON.stringify({ number: 42, title: 'Fix it', state: 'open', head: { sha: 'abc' }, html_url: 'https://github.com/octo/repo/pull/42' }), { status: 200 })
  const ok = await s.call('POST', '/v1/providers/retrieve', { provider: 'github_pr', connectionId: 'work', externalId: 'octo/repo#42' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.fields.title, 'Fix it')
  assert.equal(s.sent[0].init.headers.authorization, 'Bearer gh-secret')
  assert.ok(!JSON.stringify(ok.body).includes('gh-secret'))
  assert.equal((await s.call('POST', '/v1/providers/retrieve', { provider: 'github_pr', connectionId: 'work', externalId: 'octo/repo#42' }, null)).status, 401)
  const nocred = await s.call('POST', '/v1/providers/retrieve', { provider: 'github_pr', connectionId: 'missing', externalId: 'a/b#1' })
  assert.equal(nocred.status, 424)
  assert.equal(nocred.body.error.details.providerCode, 'unauthorized')
  s.behavior.next = () => new Response('', { status: 404 })
  const gone = await s.call('POST', '/v1/providers/retrieve', { provider: 'github_pr', connectionId: 'work', externalId: 'octo/repo#99' })
  assert.equal(gone.body.error.details.providerCode, 'not_found')
  assert.equal((await s.call('POST', '/v1/providers/retrieve', { provider: 'nope', connectionId: 'work', externalId: 'x' })).status, 422)
  s.behavior.next = () => new Response(JSON.stringify([{ id: 1, number: 1, title: 'I1', html_url: 'u', updated_at: 't', state: 'open', labels: [] }]), { status: 200 })
  const pull = await s.call('POST', '/v1/providers/pull', { provider: 'github_issues', connectionId: 'work', externalSourceId: 'octo/repo' })
  assert.equal(pull.body.items.length, 1)
  assert.equal(pull.body.complete, true)
  await s.close()
})
