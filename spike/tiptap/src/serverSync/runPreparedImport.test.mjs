import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import '../../../../db/tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbImportCheckpointStore } from './importCheckpoint.ts'
import { encodeInitialDocument } from './encodeInitialDocument.ts'
import { runPreparedImport } from './runPreparedImport.ts'
import { NevisServerApi } from './api.ts'
import { bootstrapDocument } from './bootstrap.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } })
const page = { id: 'page', title: 'test', parentId: null, favorite: false, sort: 0, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] }, updatedAt: 1, deletedAt: null }
const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
async function backupFor(value) {
  const entry = data => {
    const bytes = Buffer.from(JSON.stringify(data))
    return { data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: {
    '.nevis/vault.json': entry({ id: 'vault' }), [`pages/${value.id}.json`]: entry(value),
  } }))
  return verifySavedMigrationBackup('vault', bytes, bytes)
}
function store() {
  const name = randomUUID()
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return new IndexedDbImportCheckpointStore('vault', open)
}
function backend() {
  let manifest, completed = false
  const mutations = [], bootstraps = []
  const api = {
    async verifyIdentity(origin, id) { assert.equal(origin, scope.apiOrigin); assert.equal(id, scope.accountId) },
    async createVault(id) { assert.equal(id, 'vault'); return id },
    async beginImport(_vault, value) { if (manifest) assert.deepEqual(value, manifest); else manifest = structuredClone(value); return 'import1' },
    async importStatus() { return { id: 'import1', status: completed ? 'complete' : 'uploading', manifest: { ...manifest, archive_id: '' } } },
    async mutateDocument(_vault, id, mutation) { mutations.push({ id, mutation }); return { id, revision: 1, seq: 1 } },
    async completeImport() { completed = true },
  }
  return { api, mutations, bootstraps, get completed() { return completed } }
}

test('runner retries the same snapshot, metadata key and initial update after interruption', async () => {
  const checkpoints = store(), remote = backend(), bytes = encodeInitialDocument(schema, page)
  let tries = 0
  const input = { schema, scope, vaultName: 'Test', backup: await backupFor(page), documents: [{ page, initialUpdate: bytes }], readyAttachments: [], checkpoints, api: remote.api,
    bootstrap: async (_scope, id, data) => { assert.equal(id, page.id); remote.bootstraps.push([...data]); if (++tries === 1) throw new Error('connection lost') } }
  await assert.rejects(runPreparedImport(input), /connection lost/)
  assert.equal((await checkpoints.load(scope)).state, 'started')
  const done = await runPreparedImport(input)
  assert.equal(done.state, 'complete')
  assert.equal(remote.completed, true)
  assert.deepEqual(remote.mutations[0], remote.mutations[1])
  assert.deepEqual(remote.bootstraps[0], remote.bootstraps[1])
  assert.equal(remote.mutations[0].mutation.metadata.content, undefined)
  assert.equal(remote.mutations[0].mutation.metadata.title, 'test')
})

test('changed source or invalid document update stops before remote document writes', async () => {
  const checkpoints = store(), remote = backend(), bytes = encodeInitialDocument(schema, page)
  const input = { schema, scope, vaultName: 'Test', backup: await backupFor(page), documents: [{ page, initialUpdate: bytes }], readyAttachments: [], checkpoints, api: remote.api,
    bootstrap: async () => { throw new Error('stop after checkpoint') } }
  await assert.rejects(runPreparedImport(input), /stop after checkpoint/)
  const writes = remote.mutations.length
  const altered = { ...page, title: 'changed' }
  await assert.rejects(runPreparedImport({ ...input, documents: [{ page: altered, initialUpdate: bytes }] }), /does not match verified backup/)
  const changedBody = { ...page, content: { type: 'doc', content: [{ type: 'paragraph' }] } }
  await assert.rejects(runPreparedImport({ ...input, documents: [{ page: changedBody, initialUpdate: bytes }] }), /does not match/)
  assert.equal(remote.mutations.length, writes)
})

test('trash is tombstoned after server import and retries an ambiguous deletion', async () => {
  const checkpoints = store(), remote = backend(), trashed = { ...page, deletedAt: 123 }, bytes = encodeInitialDocument(schema, trashed)
  let deletionAttempts = 0, bootstrapCount = 0
  const originalMutation = remote.api.mutateDocument
  remote.api.mutateDocument = async (vault, id, mutation) => {
    const result = await originalMutation(vault, id, mutation)
    if (mutation.deleted && ++deletionAttempts === 1) throw new Error('delete response lost')
    return result
  }
  const input = { schema, scope, vaultName: 'Test', backup: await backupFor(trashed), documents: [{ page: trashed, initialUpdate: bytes }], readyAttachments: [], checkpoints, api: remote.api,
    bootstrap: async () => { bootstrapCount++ } }
  await assert.rejects(runPreparedImport(input), /delete response lost/)
  assert.equal(remote.completed, true)
  assert.equal((await checkpoints.load(scope)).state, 'started')
  assert.equal((await runPreparedImport(input)).state, 'complete')
  assert.equal(bootstrapCount, 1)
  assert.deepEqual(remote.mutations.map(item => item.mutation.deleted), [false, true, true])
  assert.deepEqual(remote.mutations[1], remote.mutations[2])
  assert.equal(remote.mutations[1].mutation.expected_revision, 1)
  assert.equal(remote.mutations[1].mutation.metadata.deletedAt, 123)
})

test('incomplete server import never finishes local reconciliation', async () => {
  const checkpoints = store(), remote = backend(), bytes = encodeInitialDocument(schema, page)
  remote.api.completeImport = async () => { throw new Error('incomplete documents') }
  const input = { schema, scope, vaultName: 'Test', backup: await backupFor(page), documents: [{ page, initialUpdate: bytes }], readyAttachments: [], checkpoints, api: remote.api, bootstrap: async () => {} }
  await assert.rejects(runPreparedImport(input), /incomplete documents/)
  assert.equal((await checkpoints.load(scope)).state, 'started')
})

test('runner composes the HTTP client, bootstrap transport, and durable checkpoint', async () => {
  const checkpoints = store(), bytes = encodeInitialDocument(schema, page), token = 'a'.repeat(43), requests = []
  let manifest, complete = false, initialized = false
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const send = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname
    requests.push(`${options.method} ${path}`)
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    if (path === '/v1/account') return json({ id: 'account' })
    if (path === '/v1/vaults') return json({ id: 'vault' }, 201)
    if (path === '/v1/vaults/vault/import' && options.method === 'POST') { manifest = JSON.parse(options.body); return json({ id: 'import1' }, 201) }
    if (path === '/v1/vaults/vault/import') return json({ id: 'import1', status: complete ? 'complete' : 'uploading', manifest: { ...manifest, archive_id: '' } })
    if (path === '/v1/vaults/vault/documents/page') return json({ id: 'page', revision: 1, seq: 1 })
    if (path === '/v1/documents/page/bootstrap') { assert.deepEqual(options.body, bytes); initialized = true; return json({ ok: true }, 201) }
    if (path === '/v1/vaults/vault/import/complete') { assert.equal(initialized, true); complete = true; return new Response(null, { status: 204 }) }
    throw new Error(`Unexpected request ${path}`)
  }
  const api = new NevisServerApi(scope.apiOrigin, token, send)
  const result = await runPreparedImport({ schema, scope, vaultName: 'Test', backup: await backupFor(page), documents: [{ page, initialUpdate: bytes }], readyAttachments: [], checkpoints, api,
    bootstrap: (bound, documentId, initialUpdate, signal) => bootstrapDocument({ collaborationOrigin: bound.collaborationOrigin, documentId, initialUpdate, sessionToken: token, signal }, send) })
  assert.equal(result.state, 'complete')
  assert.equal((await checkpoints.load(scope)).state, 'complete')
  assert.ok(requests.indexOf('POST /v1/vaults/vault/documents/page') < requests.indexOf('POST /v1/documents/page/bootstrap'))
  assert.ok(requests.indexOf('POST /v1/documents/page/bootstrap') < requests.indexOf('POST /v1/vaults/vault/import/complete'))
})
