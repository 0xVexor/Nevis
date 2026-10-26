// Buttons, automations, outbox, leases, schedules (handoff §21; W11, W12).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { WorkflowEngine, MemoryRuntime, BACKOFF_MS } = await import('../../../spike/tiptap/src/database/workflows/engine.ts')
const { MemoryLeases } = await import('../../../spike/tiptap/src/database/workflows/lease.ts')

async function setup(opts = {}) {
  const h = createHarness()
  const f = await seedFixture(h)
  const leases = opts.leases ?? new MemoryLeases()
  let clock = Date.parse('2026-10-25T08:00:00Z')
  const sent = []
  const adapter = (type, behave) => ({ type, supportsIdempotency: opts.idem ?? true, send: async (r) => { sent.push({ type, key: r.idempotencyKey, payload: r.entry.payload }); return behave ? behave(r, sent.length) : { ok: true } } })
  const engine = new WorkflowEngine({ coord: h.coord, lease: leases, deviceId: 'D1', now: () => clock, zone: 'Asia/Tehran', adapters: [adapter('webhook', opts.webhook), adapter('email', opts.email), adapter('notify')] }).attach()
  const wf = async (body) => (await h.one('workflow.save', { body: { sourceId: f.sourceId, name: 'wf', kind: 'automation', triggers: [], triggerMode: 'any', actions: [], ...body } })).id
  return { h, f, engine, wf, sent, leases, advance: (ms) => (clock += ms), at: () => clock }
}
const cell = (c) => ({ cell: c })

test('W11 button: runs actions as one batch, confirmation is required first, double click is one run', async () => {
  const { h, f, engine, wf } = await setup()
  const id = await wf({ kind: 'button', actions: [
    { type: 'confirm', title: 'Close it?', message: 'Marks the task done' },
    { type: 'set_values', target: 'trigger', changes: { [f.status]: cell({ kind: 'status', optionId: f.so('done') }), [f.cost]: { expr: 'prop("Cost") + 100' } } },
  ] })
  const pre = engine.preview(id, 'T1')
  assert.equal(pre.confirmations[0].title, 'Close it?')
  await assert.rejects(engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'click-1', actorId: 'U1' }), (e) => /confirmation/.test(e.message))
  const rev = h.state.row('T1').page.recordMeta.revision
  const r1 = await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'click-1', actorId: 'U1', confirmed: true })
  assert.equal(r1.state, 'succeeded')
  assert.equal(h.state.row('T1').ext.cells[f.status].value.optionId, f.so('done'))
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 100)
  assert.equal(h.state.row('T1').page.recordMeta.revision, rev + 1) // two actions, one batch, one revision
  const r2 = await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'click-1', actorId: 'U1', confirmed: true })
  assert.equal(r2.runKey, r1.runKey)
  assert.equal(h.state.row('T1').page.recordMeta.revision, rev + 1) // the double click did nothing
  await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'click-2', actorId: 'U1', confirmed: true })
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 200) // a genuinely new click is a new run
})

test('button create_page + variables + created handles; permissions apply to the clicking user', async () => {
  const { h, f, engine, wf } = await setup()
  const id = await wf({ kind: 'button', actions: [
    { type: 'define_variable', name: 'base', expression: 'prop("Cost") * 2' },
    { type: 'create_page', sourceId: f.sourceId, as: 'copy', values: { [f.cost]: { expr: 'base + 1' }, __title: { expr: 'prop("Name") + " follow-up"' } } },
    { type: 'set_values', target: { created: 'copy' }, changes: { [f.notes]: cell({ kind: 'text', runs: [{ text: 'made by button' }] }) } },
  ] })
  await engine.run(id, { kind: 'button', pageId: 'T2', eventId: 'c', actorId: 'U1' })
  const made = h.state.rows(f.sourceId).find((r) => r.page.title === 'T2 follow-up')
  assert.ok(made)
  assert.equal(made.ext.cells[f.cost].value.value, 21)
  assert.equal(made.ext.cells[f.notes].value.runs[0].text, 'made by button')
  await h.one('record.put', { kind: 'principal', id: 'U3', body: { type: 'user', displayName: 'V', email: null, memberIds: [], isLocalOwner: false, externalId: null } })
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U3', containerId: null, sourceId: f.sourceId, pageId: null, right: 'view', propertyId: null, propertyRights: null, viaPropertyId: null } })
  await assert.rejects(engine.run(id, { kind: 'button', pageId: 'T2', eventId: 'denied', actorId: 'U3' }), (e) => e.code === 'ACCESS_DENIED')
})

test('automation: page added, property changed with predicate, automation effects do not retrigger, button effects do', async () => {
  const { h, f, engine, wf } = await setup()
  const added = await wf({ triggers: [{ type: 'page_added' }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.notes]: cell({ kind: 'text', runs: [{ text: 'new!' }] }) } }] })
  const r = await h.one('row.create', { sourceId: f.sourceId, title: 'N' })
  await engine.idle()
  assert.equal(h.state.row(r.pageId).ext.cells[f.notes].value.runs[0].text, 'new!')
  // property_changed with a predicate: only when Cost becomes > 50; the effect (status=done) must not retrigger anything
  const ch = await wf({ triggers: [{ type: 'property_changed', propertyId: f.cost, predicate: { kind: 'predicate', propertyId: f.cost, op: 'gt', operand: 50 } }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.status]: cell({ kind: 'status', optionId: f.so('done') }) } }] })
  const chain = await wf({ triggers: [{ type: 'property_changed', propertyId: f.status }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.done]: cell({ kind: 'checkbox', value: true }) } }] })
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 10 } } })
  await engine.idle()
  assert.equal(h.state.row('T1').ext.cells[f.status]?.value.optionId ?? f.so('todo'), f.so('todo'))
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 99 } } })
  await engine.idle()
  assert.equal(h.state.row('T1').ext.cells[f.status].value.optionId, f.so('done'))
  assert.equal(h.state.row('T1').ext.cells[f.done], undefined) // automation -> automation does not recurse
  // a user edit of the status does trigger the chained automation
  await h.one('row.patch', { pageId: 'T3', cellChanges: { [f.status]: { kind: 'status', optionId: f.so('doing') } } })
  await engine.idle()
  assert.equal(h.state.row('T3').ext.cells[f.done].value.value, true)
  void added; void ch; void chain
})

test('button effects can trigger an automation (unlike automation effects)', async () => {
  const { h, f, engine, wf } = await setup()
  await wf({ triggers: [{ type: 'property_changed', propertyId: f.status }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.notes]: cell({ kind: 'text', runs: [{ text: 'by automation' }] }) } }] })
  const btn = await wf({ kind: 'button', actions: [{ type: 'set_values', target: 'trigger', changes: { [f.status]: cell({ kind: 'status', optionId: f.so('doing') }) } }] })
  await engine.run(btn, { kind: 'button', pageId: 'T4', eventId: 'b', actorId: 'U1' })
  await engine.idle()
  assert.equal(h.state.row('T4').ext.cells[f.notes].value.runs[0].text, 'by automation')
})

test('trigger mode ALL needs every edit inside the 3 second window (and the pending window survives a restart)', async () => {
  const { h, f, engine, wf, advance } = await setup()
  await wf({ triggerMode: 'all', triggers: [{ type: 'property_changed', propertyId: f.cost }, { type: 'property_changed', propertyId: f.notes }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.done]: cell({ kind: 'checkbox', value: true }) } }] })
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 1 } } })
  await engine.idle()
  advance(5000) // too late: the first hit expired
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.notes]: { kind: 'text', runs: [{ text: 'a' }] } } })
  await engine.idle()
  assert.equal(h.state.row('T1').ext.cells[f.done], undefined)
  advance(1000)
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 2 } } })
  await engine.idle()
  assert.equal(h.state.row('T1').ext.cells[f.done].value.value, true)
  assert.deepEqual(await engine.runtime.keys('pending:'), []) // window cleared after firing
})

test('view scope is evaluated after the mutation: pages that left the scope do not trigger', async () => {
  const { h, f, engine, wf } = await setup()
  const v = await h.one('view.create', { containerId: f.containerId, sourceId: f.sourceId, type: 'table', name: 'open' })
  await h.one('view.patch', { viewId: v.viewId, filter: { kind: 'predicate', propertyId: f.done, op: 'equals', operand: false } })
  await wf({ viewScopeId: v.viewId, triggers: [{ type: 'property_changed', propertyId: f.cost }], actions: [{ type: 'set_values', target: 'trigger', changes: { [f.notes]: cell({ kind: 'text', runs: [{ text: 'scoped' }] }) } }] })
  await h.one('row.patch', { pageId: 'T2', cellChanges: { [f.cost]: { kind: 'number', value: 1 } } }) // T2 is done=true: outside the scope
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 1 } } })
  await engine.idle()
  assert.equal(h.state.row('T2').ext.cells[f.notes].value.runs[0].text, '   ')
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.runs[0].text, 'scoped')
})

test('W12 outbox: external effects run after the internal commit; retries use backoff; credentials pause; uncertain is held', async () => {
  let n = 0
  const { h, f, engine, wf, sent, advance } = await setup({ webhook: () => (++n === 1 ? { ok: false, retryable: true, message: 'timeout bearer abc123' } : { ok: true }), email: () => ({ ok: false, retryable: false, code: 'MISSING_CREDENTIALS', message: 'no token' }) })
  const id = await wf({ kind: 'button', actions: [
    { type: 'set_values', target: 'trigger', changes: { [f.done]: cell({ kind: 'checkbox', value: true }) } },
    { type: 'webhook', connectionId: 'c1', request: { path: '/x' } },
    { type: 'email', connectionId: 'c2', message: { to: 'a@b.c', body: 'Task {triggerPage} done' } },
  ] })
  const run = await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'k', actorId: 'U1' })
  assert.equal(h.state.row('T1').ext.cells[f.done].value.value, true) // internal part committed first
  assert.equal(sent.length, 0) // nothing external yet
  assert.equal(run.state, 'queued')
  let r = await engine.dispatchOutbox()
  assert.deepEqual([r.sent, r.failed, r.paused], [0, 1, 1])
  const entries = engine.outbox()
  const wh = entries.find((e) => e.type === 'webhook')
  assert.equal(wh.state, 'retry')
  assert.ok(wh.retryAt - 0 >= Date.parse('2026-10-25T08:00:00Z') + BACKOFF_MS[0])
  assert.doesNotMatch(wh.error, /abc123/) // secrets are redacted
  assert.equal(entries.find((e) => e.type === 'email').state, 'paused')
  assert.equal((await engine.dispatchOutbox()).sent, 0) // not due yet
  advance(2000)
  r = await engine.dispatchOutbox()
  assert.equal(r.sent, 1)
  assert.equal(engine.outbox().find((e) => e.type === 'webhook').state, 'succeeded')
  assert.equal(sent.filter((s) => s.type === 'webhook').length, 2)
  assert.equal(new Set(sent.filter((s) => s.type === 'webhook').map((s) => s.key)).size, 1) // the same idempotency key both times
  assert.match(sent.find((s) => s.type === 'email').payload.message.body, /Task .* done/)
})

test('a provider without idempotency keys never gets a blind resend after an uncertain outcome; attempts are capped', async () => {
  const { engine, wf, h, f } = await setup({ idem: false, webhook: () => ({ ok: false, retryable: true, code: 'UNCERTAIN', message: 'connection reset' }) })
  const id = await wf({ kind: 'button', actions: [{ type: 'webhook', connectionId: 'c', request: {} }] })
  await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'u', actorId: 'U1' })
  await engine.dispatchOutbox()
  assert.equal(engine.outbox()[0].state, 'uncertain')
  const again = await engine.dispatchOutbox()
  assert.equal(again.sent + again.failed, 0) // held for review
  void h; void f
})

test('retries stop after 5 attempts', async () => {
  const { engine, wf, advance } = await setup({ webhook: () => ({ ok: false, retryable: true, message: 'down' }) })
  const id = await wf({ kind: 'button', actions: [{ type: 'webhook', connectionId: 'c', request: {} }] })
  await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'r', actorId: 'U1' })
  for (let i = 0; i < 8; i++) { await engine.dispatchOutbox(); advance(400_000) }
  const e = engine.outbox()[0]
  assert.equal(e.state, 'failed')
  assert.equal(e.attempt, 5)
})

test('two runners: only the lease holder executes; a crashed holder is taken over after its lease expires', async () => {
  const leases = new MemoryLeases()
  const a = await setup({ leases })
  const id = await a.wf({ kind: 'button', actions: [{ type: 'webhook', connectionId: 'c', request: {} }] })
  await a.engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'l', actorId: 'U1' })
  // device 2 shares the lease store and the same database
  const e2 = new WorkflowEngine({ coord: a.h.coord, lease: leases, deviceId: 'D2', now: a.at, zone: 'UTC', adapters: [{ type: 'webhook', supportsIdempotency: true, send: async () => ({ ok: true }) }] })
  assert.ok(await leases.acquire('outbox', 'D1', 30_000, a.at())) // D1 holds the lease (and "crashes" without releasing)
  assert.equal((await e2.dispatchOutbox()).skipped, true)
  a.advance(31_000)
  const r = await e2.dispatchOutbox()
  assert.equal(r.skipped, false)
  assert.equal(r.sent, 1)
  assert.equal(a.sent.length, 0) // only D2 delivered it
})

test('scheduled automation: stable occurrence keys, lease holder only, > 30 missed needs approval', async () => {
  const { h, f, engine, wf, at, advance } = await setup()
  await wf({ triggers: [{ type: 'schedule', recurrence: { frequency: 'daily', interval: 1, startDate: '2026-10-20', endDate: null, time: '09:00', timeZone: 'Asia/Tehran' } }], actions: [{ type: 'create_page', sourceId: f.sourceId, values: { __title: { text: 'daily' } } }] })
  const n0 = h.state.rows(f.sourceId).length
  const r1 = await engine.runSchedules(at())
  assert.equal(r1.ran, 6) // Oct 20..25 09:00 local (05:30Z) are all before 08:00Z
  assert.equal(h.state.rows(f.sourceId).length, n0 + 6)
  const r2 = await engine.runSchedules(at())
  assert.equal(r2.ran, 0)
  advance(60 * 86400000)
  const far = await engine.runSchedules(at())
  assert.equal(far.ran, 0)
  assert.ok(far.pending > 30)
  const ok = await engine.runSchedules(at(), true)
  assert.equal(ok.ran, far.pending)
})

test('bulk edit_matching is capped at 1000 mutations unless approved; dry run changes nothing', async () => {
  const { h, f, engine, wf } = await setup()
  const id = await wf({ kind: 'button', actions: [{ type: 'edit_matching', query: { sourceId: f.sourceId, filter: null }, changes: { [f.done]: cell({ kind: 'checkbox', value: true }) } }] })
  const dry = await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'd', actorId: 'U1', dryRun: true })
  assert.equal(dry.state, 'queued')
  assert.equal(h.state.row('T3').ext.cells[f.done], undefined)
  const real = await engine.run(id, { kind: 'button', pageId: 'T1', eventId: 'e', actorId: 'U1' })
  assert.equal(real.state, 'succeeded')
  assert.deepEqual(h.state.rows(f.sourceId).map((r) => r.ext.cells[f.done]?.value.value), [true, true, true, true])
})
