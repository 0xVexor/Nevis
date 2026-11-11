import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbImportCheckpointStore } from '../spike/tiptap/src/serverSync/importCheckpoint.ts'
import { startOrResumeImport } from '../spike/tiptap/src/serverSync/resumeImport.ts'

const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
const backup = 'a'.repeat(64), hash = 'b'.repeat(64), source = 'd'.repeat(64)
const manifest = { documents: ['page'], attachments: ['asset'], fingerprints: { page: hash }, attachment_hashes: { asset: hash } }
function database() {
  const name = randomUUID()
  return () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

test('lost start and completion responses resume the same durable import', async () => {
  const open = database(), store = new IndexedDbImportCheckpointStore('vault', open)
  let starts = 0, completions = 0, remote = null, complete = false
  const api = {
    verifyIdentity: async () => {},
    async beginImport(_vault, sent) {
      starts++
      if (remote) assert.deepEqual(sent, remote)
      else remote = structuredClone(sent)
      if (starts === 1) throw new Error('start response lost')
      return 'import1'
    },
    async importStatus() { return { id: 'import1', status: complete ? 'complete' : 'uploading', manifest: { ...remote, archive_id: '' } } },
    async completeImport() { completions++; complete = true; throw new Error('completion response lost') },
  }
  await assert.rejects(startOrResumeImport(scope, backup, source, manifest, store, api), /start response lost/)
  assert.equal((await store.load(scope)).state, 'prepared')
  const reopened = new IndexedDbImportCheckpointStore('vault', open)
  await startOrResumeImport(scope, backup, source, manifest, reopened, api)
  await assert.rejects(api.completeImport(), /completion response lost/)
  assert.equal((await reopened.load(scope)).state, 'started')
  const resumed = await startOrResumeImport(scope, backup, source, manifest, new IndexedDbImportCheckpointStore('vault', open), api)
  assert.equal(resumed.state, 'started') // caller must finish local reconciliation
  const result = await reopened.completed(scope, 'import1')
  assert.equal(result.state, 'complete')
  assert.equal(result.importId, 'import1')
  assert.equal(starts, 2)
  assert.equal(completions, 1)
})

test('manifest changes, wrong remote ID and remote rollback do not advance checkpoint', async () => {
  const store = new IndexedDbImportCheckpointStore('vault', database())
  await store.prepare(scope, backup, source, manifest)
  await assert.rejects(store.prepare(scope, 'c'.repeat(64), source, manifest), /mismatch/)
  await assert.rejects(store.prepare(scope, backup, 'e'.repeat(64), manifest), /mismatch/)
  await assert.rejects(store.prepare(scope, backup, source, { ...manifest, documents: [] }), /fingerprints/)
  await store.started(scope, 'import1')
  await assert.rejects(store.started(scope, 'other'), /mismatch/)
  const api = { verifyIdentity: async () => {}, beginImport: async () => 'import1', importStatus: async () => ({ id: 'other', status: 'uploading', manifest }), completeImport: async () => {} }
  await assert.rejects(startOrResumeImport(scope, backup, source, manifest, store, api), /ID mismatch/)
  assert.equal((await store.load(scope)).state, 'started')
  await store.completed(scope, 'import1')
  api.importStatus = async () => ({ id: 'import1', status: 'uploading', manifest })
  await assert.rejects(startOrResumeImport(scope, backup, source, manifest, store, api), /no longer complete/)
})

test('concurrent preparations cannot replace the checkpoint', async () => {
  const open = database(), a = new IndexedDbImportCheckpointStore('vault', open), b = new IndexedDbImportCheckpointStore('vault', open)
  const results = await Promise.allSettled([a.prepare(scope, backup, source, manifest), b.prepare(scope, 'c'.repeat(64), source, manifest)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const record = await a.load(scope)
  assert.ok([backup, 'c'.repeat(64)].includes(record.backupSha256))
  await assert.rejects(a.load({ ...scope, vaultId: 'other' }), /vault unavailable/)
})

test('a different signed-in account cannot create an import checkpoint', async () => {
  const store = new IndexedDbImportCheckpointStore('vault', database())
  const api = { verifyIdentity: async () => { throw new Error('Server account mismatch') } }
  await assert.rejects(startOrResumeImport(scope, backup, source, manifest, store, api), /account mismatch/)
  assert.equal(await store.load(scope), null)
})
