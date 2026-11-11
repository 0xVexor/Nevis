import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import '../../../../db/tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbAttachmentAttemptStore, transferWithStoredAttempt } from './attachmentAttempts.ts'
import { ServerApiError } from './api.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
function database() {
  const name = randomUUID()
  return () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function backupFixture() {
  const asset = Buffer.from('asset'), sha256 = createHash('sha256').update(asset).digest('hex')
  const entry = bytes => ({ data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
  const json = value => entry(Buffer.from(JSON.stringify(value)))
  const path = `files/${sha256.slice(0, 2)}/${sha256}`
  const page = { id: 'page', parentId: null, title: 'Note', content: { type: 'doc' }, favorite: false, sort: 0, updatedAt: 1, deletedAt: null }
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: {
    '.nevis/vault.json': json({ id: 'vault' }), 'pages/page.json': json(page), [path]: entry(asset), [`${path}.json`]: json({ id: sha256, size: asset.length }),
  } }))
  return { backup: await verifySavedMigrationBackup('vault', bytes, bytes), sha256 }
}

test('concurrent expiration persists exactly one new attempt', async () => {
  const open = database(), a = new IndexedDbAttachmentAttemptStore('vault', open), b = new IndexedDbAttachmentAttemptStore('vault', open)
  const key = { scope, backupSha256: 'a'.repeat(64), documentId: 'page', sha256: 'b'.repeat(64) }
  assert.deepEqual(await a.current(key), { attempt: 0, readyId: null })
  assert.deepEqual(await Promise.all([a.expired(key, 0), b.expired(key, 0)]), [{ attempt: 1, readyId: null }, { attempt: 1, readyId: null }])
  assert.deepEqual(await new IndexedDbAttachmentAttemptStore('vault', open).current(key), { attempt: 1, readyId: null })
  await assert.rejects(a.expired(key, 4), /mismatch/)
  await assert.rejects(a.current({ ...key, scope: { ...scope, vaultId: 'other' } }), /vault unavailable/)
})

test('only definite reservation expiry advances the durable attempt', async () => {
  const { backup, sha256 } = await backupFixture(), store = new IndexedDbAttachmentAttemptStore('vault', database()), keys = []
  let calls = 0
  const api = {
    verifyIdentity: async () => {},
    beginAttachment: async (_doc, _hash, _size, key) => { keys.push(key); if (++calls === 1) throw new ServerApiError(410); return { id: 'id', ready: false, uploadUrl: 'https://objects.example/put', expiresIn: 60 } },
    completeAttachment: async () => {},
  }
  const input = { scope, backup, documentId: 'page', sha256, api, send: async () => { throw new ServerApiError(410) } }
  await assert.rejects(transferWithStoredAttempt(input, store), error => error instanceof ServerApiError && error.status === 410)
  const attemptScope = { scope, backupSha256: backup.sha256, documentId: 'page', sha256 }
  assert.deepEqual(await store.current(attemptScope), { attempt: 1, readyId: null })
  assert.notEqual(keys[0], keys[1])
  input.send = async () => new Response(null, { status: 200 })
  assert.deepEqual(await transferWithStoredAttempt(input, store), { id: 'id', sha256 })
  assert.equal(keys[1], keys[2])
  assert.deepEqual(await store.current(attemptScope), { attempt: 1, readyId: 'id' })
  assert.deepEqual(await transferWithStoredAttempt(input, store), { id: 'id', sha256 })
  assert.equal(keys.length, 3)
})
