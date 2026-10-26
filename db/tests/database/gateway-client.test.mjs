// Desktop <-> gateway: publish a form from a real database, submit as the public, pull + apply + acknowledge, survive a lost acknowledgment.
import test from 'node:test'
import assert from 'node:assert/strict'

const { DatabaseService } = await import('../../../spike/tiptap/src/database/service.ts')
const { MemoryPages } = await import('../../../spike/tiptap/src/database/state.ts')
const { MemoryStorage } = await import('../../../spike/tiptap/src/database/storage/memory.ts')
const { MemoryPageHost } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { GatewayClient, GatewayError, buildPublication, pullInbox } = await import('../../../spike/tiptap/src/database/gateway/client.ts')
const { createGateway } = await import('../../../services/database-gateway/src/server.ts')
const { loadConfig } = await import('../../../services/database-gateway/src/config.ts')

const OWNER = 'k'.repeat(40)
const servers = []
process.on('exit', () => servers.forEach((s) => { try { s.close() } catch { /* closed */ } }))

async function setup() {
  const pages = new MemoryPages()
  const svc = new DatabaseService({ vaultId: 'v', storage: new MemoryStorage(pages), pages, host: new MemoryPageHost(pages), deviceId: 'D1', zone: 'UTC' })
  await svc.open()
  const db = await svc.one('database.create', { title: 'Bugs' })
  const sev = (await svc.one('property.create', { sourceId: db.sourceId, name: 'Severity', kind: 'select', config: { options: [{ name: 'Low' }, { name: 'High' }] } })).propertyId
  const secret = (await svc.one('property.create', { sourceId: db.sourceId, name: 'Internal', kind: 'text' })).propertyId
  const form = (await svc.one('view.create', { containerId: db.containerId, sourceId: db.sourceId, type: 'form', name: 'Report' })).viewId
  const title = db.titlePropertyId
  await svc.one('form.configure', { viewId: form, config: { version: 0, open: true, anonymous: false, submitMessage: 'Thanks', questions: [
    { id: 'q1', propertyId: title, title: 'What happened?', description: '', syncLabel: true, required: true, order: 0 },
    { id: 'q2', propertyId: sev, title: 'Severity', description: '', syncLabel: true, required: false, order: 1 }] } })
  const gw = createGateway(loadConfig({ GATEWAY_OWNER_TOKEN: OWNER, GATEWAY_DB: ':memory:', GATEWAY_PORT: '0' }))
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r))
  servers.push(gw.server)
  const url = `http://127.0.0.1:${gw.server.address().port}`
  const flaky = { failAck: 0 }
  const client = new GatewayClient({ url, token: OWNER }, async (u, init) => {
    if (flaky.failAck > 0 && String(u).includes('/ack')) { flaky.failAck--; throw new TypeError('network down') }
    return fetch(u, init)
  })
  const rows = () => svc.query(db.sourceId, { limit: 50 }).total
  return { svc, db, form, sev, secret, gw, url, client, flaky, rows }
}
const submit = (url, publicId, id, answers) => fetch(`${url}/v1/forms/${publicId}/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submissionId: id, answers }) }).then(async (r) => ({ status: r.status, body: await r.json() }))

test('the projection contains only asked properties and options, never the rest of the source', async () => {
  const { svc, form, client, gw, secret, url } = await setup()
  const payload = buildPublication(svc, form)
  assert.deepEqual(payload.properties.map((p) => p.name).sort(), ['Name', 'Severity'])
  assert.ok(!JSON.stringify(payload).includes(secret))
  const pub = await client.publish(payload)
  const pubView = await fetch(`${url}/v1/forms/${pub.publicId}`).then((r) => r.json())
  assert.deepEqual(pubView.questions[1].options.map((o) => o.name), ['Low', 'High'])
  assert.ok(!JSON.stringify(pubView).includes('Internal'))
  await gw.close()
})

test('a public answer becomes a row only after the desktop pulls and applies it; the receipt then says applied', async () => {
  const { svc, db, form, sev, client, gw, url, rows } = await setup()
  const pub = await client.publish(buildPublication(svc, form))
  const links = { [form]: { ...pub, viewId: form } }
  const high = svc.state.prop(sev).config.options.find((o) => o.name === 'High').id
  const r = await submit(url, pub.publicId, 'sub-00000001', { q1: 'App crashes', q2: high })
  assert.equal(r.status, 201)
  assert.equal(rows(), 0) // still only pending import
  assert.deepEqual(await pullInbox(svc, client, links), { applied: 1, rejected: 0 })
  assert.equal(rows(), 1)
  const row = svc.query(db.sourceId, { limit: 5 }).pageIds[0]
  assert.equal(svc.state.pages.get(row).title, 'App crashes')
  const receipt = await fetch(`${url}/v1/submissions/${r.body.receipt}`).then((x) => x.json())
  assert.equal(receipt.status, 'applied')
  assert.deepEqual(await pullInbox(svc, client, links), { applied: 0, rejected: 0 })
  await gw.close()
})

test('a lost acknowledgment re-applies to the same receipt: no duplicate row', async () => {
  const { svc, form, client, gw, url, flaky, rows } = await setup()
  const pub = await client.publish(buildPublication(svc, form))
  const links = { [form]: { ...pub, viewId: form } }
  await submit(url, pub.publicId, 'sub-00000002', { q1: 'Lost ack' })
  flaky.failAck = 1
  assert.deepEqual(await pullInbox(svc, client, links), { applied: 0, rejected: 0 }) // applied locally, ack failed
  assert.equal(rows(), 1)
  // the lease on the gateway expires, the item is handed out again
  gw.db.prepare('UPDATE submissions SET leased_until = 0').run()
  assert.deepEqual(await pullInbox(svc, client, links), { applied: 1, rejected: 0 })
  assert.equal(rows(), 1) // still one row
  await gw.close()
})

test('a submission that no longer fits the current form is rejected with a reason and kept for repair', async () => {
  const { svc, form, client, gw, url, rows } = await setup()
  const pub = await client.publish(buildPublication(svc, form))
  const links = { [form]: { ...pub, viewId: form } }
  await submit(url, pub.publicId, 'sub-00000003', { q1: 'Will not fit' })
  // the owner closes the form locally before pulling: the desktop refuses to import into a closed form
  const cfg = svc.state.get('view', form).configuration
  await svc.one('form.configure', { viewId: form, config: { ...cfg, open: false } })
  assert.deepEqual(await pullInbox(svc, client, links), { applied: 0, rejected: 1 })
  assert.equal(rows(), 0)
  const st = await client.publicationStatus(pub.id)
  assert.equal(st.submissions.rejected, 1)
  await gw.close()
})

test('status and errors: wrong token = unauthorized, no server = offline, workspaces = unsupported', async () => {
  const { client, gw, url } = await setup()
  assert.equal(await client.status(), 'ready')
  assert.equal(await new GatewayClient({ url, token: 'x'.repeat(40) }).status(), 'unauthorized')
  assert.equal(await new GatewayClient({ url: 'http://127.0.0.1:1', token: OWNER }).status(), 'offline')
  const caps = await client.capabilities()
  assert.equal(caps.sharedWorkspace, 'unsupported')
  await assert.rejects(() => new GatewayClient({ url, token: OWNER }).publish({}), (e) => e instanceof GatewayError && e.status === 400)
  await gw.close()
})
