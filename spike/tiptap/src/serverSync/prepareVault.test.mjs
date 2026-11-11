import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import '../../../../db/tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbInitializationStore } from './initializationStore.ts'
import { prepareVaultDocuments } from './prepareVault.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } })
const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
const page = { id: 'page', parentId: null, title: 'Test', favorite: false, sort: 0, content: { type: 'doc', content: [{ type: 'paragraph' }] }, updatedAt: 1, deletedAt: null }
function database() {
  const name = randomUUID()
  return () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('kv'); request.result.createObjectStore('pages', { keyPath: 'id' }).put(page) }
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function backup() {
  const entry = value => { const data = Buffer.from(JSON.stringify(value)); return { data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') } }
  const raw = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: { '.nevis/vault.json': entry({ id: 'vault' }), 'pages/page.json': entry(page) } }))
  return verifySavedMigrationBackup('vault', raw, raw)
}

test('prepares all verified pages and retains exact bytes across restart', async () => {
  const open = database(), proof = await backup()
  const first = await prepareVaultDocuments({ schema, scope, backup: proof, initializations: new IndexedDbInitializationStore('vault', open) })
  const second = await prepareVaultDocuments({ schema, scope, backup: proof, initializations: new IndexedDbInitializationStore('vault', open) })
  assert.deepEqual(first, second)
  assert.equal(first[0].page.id, 'page')
  assert.ok(first[0].initialUpdate.length > 0)
})

test('an edited live page stops both initial preparation and a retained retry', async () => {
  const open = database(), proof = await backup(), initializations = new IndexedDbInitializationStore('vault', open)
  await prepareVaultDocuments({ schema, scope, backup: proof, initializations })
  const db = await open(), tx = db.transaction('pages', 'readwrite')
  tx.objectStore('pages').put({ ...page, title: 'newer' })
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject })
  await assert.rejects(prepareVaultDocuments({ schema, scope, backup: proof, initializations }), /page changed/)
})
