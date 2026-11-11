import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { NevisServerApi, ServerApiError, uploadAttachment, validateManifest } from './api.ts'

const token = 'a'.repeat(43), hash = 'b'.repeat(64)
const manifest = () => ({ documents: ['page'], attachments: ['asset'], fingerprints: { page: hash }, attachment_hashes: { asset: hash } })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('vault, mutation and resumable import use the server contract', async () => {
  const requests = []
  const send = async (url, init) => {
    const path = new URL(url).pathname
    requests.push({ path, ...init, body: init.body && JSON.parse(init.body) })
    if (path === '/v1/vaults') return json({ id: 'vault' }, 201)
    if (path.endsWith('/documents/page')) return json({ id: 'page', revision: 1, seq: 9 })
    if (path.endsWith('/import/complete')) return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ id: 'import' }, 201)
    return json({ id: 'import', status: 'uploading', manifest: { ...manifest(), archive_id: '' } })
  }
  const api = new NevisServerApi('https://api.example', token, send)
  assert.equal(await api.createVault('vault', 'Workspace'), 'vault')
  const mutation = { key: 'stable_key', expected_revision: 0, metadata: { title: 'Note' }, deleted: false }
  assert.deepEqual(await api.mutateDocument('vault', 'page', mutation), { id: 'page', revision: 1, seq: 9 })
  assert.equal(await api.beginImport('vault', manifest()), 'import')
  assert.equal((await api.importStatus('vault')).status, 'uploading')
  await api.completeImport('vault')
  assert.deepEqual(requests.map(x => x.path), ['/v1/vaults', '/v1/vaults/vault/documents/page', '/v1/vaults/vault/import', '/v1/vaults/vault/import', '/v1/vaults/vault/import/complete'])
  assert.deepEqual(requests[1].body, mutation)
  assert.deepEqual(requests[2].body, manifest())
  for (const request of requests) {
    assert.equal(request.headers.Authorization, `Bearer ${token}`)
    assert.equal(request.redirect, 'error')
    assert.equal(request.credentials, 'omit')
  }
})

test('invalid manifests, unsafe origins and inconsistent response values fail closed', async () => {
  assert.throws(() => new NevisServerApi('http://elsewhere.test', token), /origin/)
  assert.throws(() => new NevisServerApi('https://user:pass@api.example', token), /origin/)
  assert.throws(() => validateManifest({ ...manifest(), documents: ['page', 'page'] }), /Duplicate/)
  assert.throws(() => validateManifest({ ...manifest(), attachment_hashes: {} }), /fingerprints/)
  assert.throws(() => validateManifest({ ...manifest(), archive_id: 'asset' }), /Duplicate/)
  const api = new NevisServerApi('http://127.0.0.1:8080', token, async () => json({ id: 'different', revision: 1, seq: 1 }))
  await assert.rejects(api.mutateDocument('vault', 'page', { key: 'key', expected_revision: 0, metadata: {}, deleted: false }), /response/)
  await assert.rejects(api.mutateDocument('vault', 'page', { key: 'key', expected_revision: 0, metadata: { doc: {} }, deleted: false }), /metadata/)
  await assert.rejects(api.completeImport('../vault'), /identifier/)
})

test('a server error exposes its status without leaking credentials or response body', async () => {
  const api = new NevisServerApi('https://api.example', token, async () => json({ error: 'private data' }, 409))
  await assert.rejects(api.beginImport('vault', manifest()), error => {
    assert.ok(error instanceof ServerApiError)
    assert.equal(error.status, 409)
    assert.doesNotMatch(error.message, /private|aaaa/)
    return true
  })
})

test('checkpoint identity is checked against server origin and active account', async () => {
  let calls = 0
  const api = new NevisServerApi('https://api.example', token, async () => { calls++; return json({ id: 'account' }) })
  await api.verifyIdentity('https://api.example:443', 'account')
  await assert.rejects(api.verifyIdentity('https://other.example', 'account'), /origin mismatch/)
  await assert.rejects(api.verifyIdentity('https://api.example', 'other'), /account mismatch/)
  assert.equal(calls, 2)
})

test('attachment reservation and completion follow the server contract', async () => {
  const calls = []
  const api = new NevisServerApi('https://api.example', token, async (url, options) => {
    calls.push({ path: new URL(url).pathname, options })
    return calls.length === 1 ? json({ id: 'attachment', upload_url: 'https://objects.example/staging/a?signature=secret', expires_in: 60 }, 201) : new Response(null, { status: 204 })
  })
  const reservation = await api.beginAttachment('page', hash, 12, 'retry-key')
  assert.deepEqual(reservation, { id: 'attachment', ready: false, uploadUrl: 'https://objects.example/staging/a?signature=secret', expiresIn: 60 })
  assert.deepEqual(JSON.parse(calls[0].options.body), { sha256: hash, size: 12, key: 'retry-key' })
  await api.completeAttachment('page', reservation.id)
  assert.equal(calls[1].path, '/v1/documents/page/attachments/attachment/complete')
})

test('a completed reservation can be resumed without an upload URL', async () => {
  const api = new NevisServerApi('https://api.example', token, async () => json({ id: 'attachment', ready: true }, 200))
  assert.deepEqual(await api.beginAttachment('page', hash, 12, 'retry-key'), { id: 'attachment', ready: true })
})

test('change feed advances only across valid ordered server records', async () => {
  let value = { changes: [{ seq: 12, id: 'page', revision: 2, deleted: false, metadata: { title: 'Changed' } }], next: 12, has_more: false }
  const api = new NevisServerApi('https://api.example', token, async url => {
    assert.equal(new URL(url).search, '?since=10')
    return json(value)
  })
  assert.deepEqual(await api.changes('vault', 10), { changes: value.changes, next: 12, hasMore: false })
  value = { ...value, next: 13 }
  await assert.rejects(api.changes('vault', 10), /response/)
  value = { ...value, next: 12, has_more: true }
  await assert.rejects(api.changes('vault', 10), /response/)
  await assert.rejects(api.changes('vault', -1), /cursor/)
})

test('signed upload sends the exact bytes and length without the session token', async t => {
  let observed
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    observed = { headers: req.headers, bytes: Buffer.concat(chunks) }
    res.writeHead(200); res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const bytes = new TextEncoder().encode('attachment')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await uploadAttachment(`http://127.0.0.1:${server.address().port}/staging?signature=private`, bytes, digest)
  assert.deepEqual(observed.bytes, Buffer.from(bytes))
  assert.equal(observed.headers['content-length'], String(bytes.length))
  assert.equal(observed.headers.authorization, undefined)
  await assert.rejects(uploadAttachment('https://objects.example/staging', bytes, hash), /hash mismatch/)
  await assert.rejects(uploadAttachment('http://remote.example/staging', bytes, digest), /URL/)
})
