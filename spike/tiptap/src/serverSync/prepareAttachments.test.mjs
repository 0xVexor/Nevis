import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import '../../../../db/tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbAttachmentAttemptStore } from './attachmentAttempts.ts'
import { IndexedDbImportCheckpointStore } from './importCheckpoint.ts'
import { encodeInitialDocument } from './encodeInitialDocument.ts'
import { prepareBackupAttachments } from './prepareAttachments.ts'
import { runPreparedImport } from './runPreparedImport.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const schema = new Schema({ nodes: { doc: { content: 'block+' }, image: { group: 'block', atom: true, attrs: { src: { default: '' } } }, text: {} } })
const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
function database() {
  const name = randomUUID()
  return () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1); req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
  })
}
async function fixture() {
  const asset = Buffer.from('image'), hash = createHash('sha256').update(asset).digest('hex')
  const page = id => ({ id, parentId: null, title: id, content: { type: 'doc', content: [{ type: 'image', attrs: { src: `att:${hash}` } }] }, favorite: false, sort: 0, updatedAt: 1, deletedAt: null })
  const pages = [page('a'), page('b')]
  const entry = bytes => ({ data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
  const json = value => entry(Buffer.from(JSON.stringify(value)))
  const path = `files/${hash.slice(0, 2)}/${hash}`
  const entries = { '.nevis/vault.json': json({ id: 'vault' }), [path]: entry(asset), [`${path}.json`]: json({ id: hash, size: asset.length }) }
  for (const p of pages) entries[`pages/${p.id}.json`] = json(p)
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries }))
  const backup = await verifySavedMigrationBackup('vault', bytes, bytes)
  return { backup, pages, hash, asset, documents: pages.map(page => ({ page, initialUpdate: encodeInitialDocument(schema, page) })) }
}

test('shared attachments resume per document and feed the prepared import', async () => {
  const f = await fixture(), open = database(), attempts = new IndexedDbAttachmentAttemptStore('vault', open), checkpoints = new IndexedDbImportCheckpointStore('vault', open)
  const mutationKeys = new Map(), reservations = new Map(), uploads = [], keys = []
  let completed = false, manifest
  const api = {
    verifyIdentity: async () => {}, createVault: async id => id,
    async mutateDocument(_vault, id, mutation) {
      if (mutationKeys.has(id)) assert.equal(mutationKeys.get(id), mutation.key)
      else mutationKeys.set(id, mutation.key)
      return { id, revision: 1, seq: 1 }
    },
    async beginAttachment(doc, hash, size, key) {
      assert.equal(hash, f.hash); assert.equal(size, f.asset.length); keys.push({ doc, key })
      if (!reservations.has(key)) reservations.set(key, { id: `asset_${doc}`, ready: false })
      const state = reservations.get(key)
      return state.ready ? { id: state.id, ready: true } : { id: state.id, ready: false, uploadUrl: `https://objects.example/${doc}`, expiresIn: 60 }
    },
    async completeAttachment(_doc, id) { [...reservations.values()].find(value => value.id === id).ready = true },
    async beginImport(_vault, input) { manifest = input; return 'import1' },
    async importStatus() { return { id: 'import1', status: completed ? 'complete' : 'uploading', manifest: { ...manifest, archive_id: '' } } },
    async completeImport() { completed = true },
  }
  let failB = true
  const send = async url => { const doc = new URL(url).pathname.slice(1); uploads.push(doc); if (doc === 'b' && failB) { failB = false; throw new Error('network lost') } return new Response(null, { status: 200 }) }
  const input = { schema, scope, vaultName: 'Test', backup: f.backup, documents: f.documents, attempts, api, send }
  await assert.rejects(prepareBackupAttachments(input), /network lost/)
  const ready = await prepareBackupAttachments(input)
  assert.deepEqual(ready.map(({ documentId, sha256 }) => ({ documentId, sha256 })), [{ documentId: 'a', sha256: f.hash }, { documentId: 'b', sha256: f.hash }])
  assert.deepEqual(uploads, ['a', 'b', 'b'])
  assert.equal(keys.filter(key => key.doc === 'a').length, 1)
  const result = await runPreparedImport({ ...input, checkpoints, readyAttachments: ready, bootstrap: async () => {} })
  assert.equal(result.state, 'complete')
  assert.equal(manifest.attachments.length, 2)
})

test('a missing association fails before any server request', async () => {
  const f = await fixture(), attempts = new IndexedDbAttachmentAttemptStore('vault', database())
  const withoutOne = f.documents.slice(0, 1)
  await assert.rejects(prepareBackupAttachments({ schema, scope, vaultName: 'Test', backup: f.backup, documents: withoutOne, attempts, api: {} }), /does not match verified backup/)
})
