import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import '../../../../db/tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbInitializationStore } from './initializationStore.ts'
import { IndexedDbAttachmentAttemptStore } from './attachmentAttempts.ts'
import { IndexedDbImportCheckpointStore } from './importCheckpoint.ts'
import { importVerifiedVault, SourceChangedDuringImport } from './importVerifiedVault.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } })
const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
const page = { id: 'page', parentId: null, title: 'Test', favorite: false, sort: 0, content: { type: 'doc', content: [{ type: 'paragraph' }] }, updatedAt: 1, deletedAt: null }
async function fixture() {
  const entry = value => { const data = Buffer.from(JSON.stringify(value)); return { data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') } }
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: { '.nevis/vault.json': entry({ id: 'vault' }), 'pages/page.json': entry(page) } }))
  const backup = await verifySavedMigrationBackup('vault', bytes, bytes), name = randomUUID()
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('kv'); request.result.createObjectStore('pages', { keyPath: 'id' }).put(page) }
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  let manifest, complete = false, calls = 0
  const api = {
    async verifyIdentity() {}, async createVault(id) { calls++; return id },
    async mutateDocument() { calls++; return { id: 'page', revision: 1, seq: 1 } },
    async beginAttachment() { throw new Error('unexpected attachment') }, async completeAttachment() {},
    async beginImport(_vault, input) { calls++; manifest = input; return 'import1' },
    async importStatus() { return { id: 'import1', status: complete ? 'complete' : 'uploading', manifest: { ...manifest, archive_id: '' } } },
    async completeImport() { calls++; complete = true },
  }
  const phases = [], current = { vaultId: 'vault', pages: [structuredClone(page)], attachmentIds: [] }
  const input = { schema, scope, vaultName: 'Test', backup, initializations: new IndexedDbInitializationStore('vault', open),
    attempts: new IndexedDbAttachmentAttemptStore('vault', open), checkpoints: new IndexedDbImportCheckpointStore('vault', open), api,
    bootstrap: async () => { calls++ }, loadCurrent: async () => structuredClone(current), progress: phase => phases.push(phase) }
  return { input, current, phases, get calls() { return calls }, get complete() { return complete } }
}

test('verified vault import composes persisted preparation and server operations without enabling live sync', async () => {
  const f = await fixture()
  assert.deepEqual(await importVerifiedVault(f.input), { state: 'imported', importId: 'import1' })
  assert.deepEqual(f.phases, ['preparing', 'attachments', 'importing', 'checking'])
  assert.equal(f.complete, true)
  assert.equal((await f.input.checkpoints.load(scope)).state, 'complete')
})

test('a changed source stops before remote work', async () => {
  const f = await fixture()
  f.current.pages[0].title = 'Changed'
  await assert.rejects(importVerifiedVault(f.input), error => error instanceof SourceChangedDuringImport && !error.remoteImportMayBeComplete)
  assert.equal(f.calls, 0)
})

test('a change during server completion is reported as requiring reconciliation', async () => {
  const f = await fixture(), finish = f.input.api.completeImport
  f.input.api.completeImport = async () => { await finish(); f.current.pages[0].title = 'Edited while importing' }
  await assert.rejects(importVerifiedVault(f.input), error => error instanceof SourceChangedDuringImport && error.remoteImportMayBeComplete)
  assert.equal(f.complete, true)
  assert.equal((await f.input.checkpoints.load(scope)).state, 'complete')
})
