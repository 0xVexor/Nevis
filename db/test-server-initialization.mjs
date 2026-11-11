import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { IndexedDbInitializationStore } from '../spike/tiptap/src/serverSync/initializationStore.ts'
import { resumeInitialization } from '../spike/tiptap/src/serverSync/resumeInitialization.ts'
import { NativeInitializationStore } from '../spike/tiptap/src/serverSync/nativeInitializationStore.ts'

const page = { id: 'page', parentId: null, title: 'test', favorite: false, sort: 0, content: { type: 'doc' }, updatedAt: 1, deletedAt: null }
function database() {
  const name = randomUUID()
  return () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('kv')
      request.result.createObjectStore('pages', { keyPath: 'id' }).put(page)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
const scope = { vaultId: 'vault', accountId: 'account', collaborationOrigin: 'https://sync.example', documentId: 'page' }

test('initialization survives a reopened store and rejects replacement', async () => {
  const open = database(), first = new IndexedDbInitializationStore('vault', open)
  const source = new Uint8Array([1, 2, 3])
  await first.prepare(scope, source, page)
  source[0] = 9
  const reopened = new IndexedDbInitializationStore('vault', open)
  assert.deepEqual(await reopened.load(scope), new Uint8Array([1, 2, 3]))
  await reopened.prepare(scope, new Uint8Array([1, 2, 3]), page)
  await assert.rejects(reopened.prepare(scope, new Uint8Array([9, 2, 3]), page), /different bytes/)
  assert.deepEqual(await reopened.load(scope), new Uint8Array([1, 2, 3]))
})

test('concurrent candidates cannot overwrite one another', async () => {
  const open = database(), a = new IndexedDbInitializationStore('vault', open), b = new IndexedDbInitializationStore('vault', open)
  const candidates = [new Uint8Array([1]), new Uint8Array([2])]
  const results = await Promise.allSettled([a.prepare(scope, candidates[0], page), b.prepare(scope, candidates[1], page)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const winner = results.findIndex(result => result.status === 'fulfilled')
  assert.deepEqual(await a.load(scope), candidates[winner])
})

test('records are scoped to account, origin, document and vault', async () => {
  const open = database(), store = new IndexedDbInitializationStore('vault', open)
  await store.prepare(scope, new Uint8Array([7]), page)
  for (const different of [{ accountId: 'other' }, { collaborationOrigin: 'https://other.example' }, { documentId: 'other' }])
    assert.equal(await store.load({ ...scope, ...different }), null)
  await assert.rejects(store.load({ ...scope, vaultId: 'other' }), /vault unavailable/)
  assert.deepEqual(await store.load({ ...scope, collaborationOrigin: 'https://sync.example:443/' }), new Uint8Array([7]))
})

test('unavailable vaults and invalid scopes fail closed', async () => {
  const open = database()
  let active = true
  const store = new IndexedDbInitializationStore('vault', open, () => active)
  await store.prepare(scope, new Uint8Array([1]), page)
  active = false
  await assert.rejects(store.load(scope), /vault unavailable/)
  active = true
  await assert.rejects(store.prepare({ ...scope, collaborationOrigin: 'http://remote.example' }, new Uint8Array([1]), page), /origin/)
  await assert.rejects(store.prepare(scope, new Uint8Array(), page), /size/)
})

test('a lost response retries the stored bytes after reopening', async () => {
  const open = database(), store = new IndexedDbInitializationStore('vault', open)
  await assert.rejects(resumeInitialization(scope, store, 'token', { send: async () => { throw new Error('must not send') } }), /not been prepared/)
  await store.prepare(scope, new Uint8Array([3, 4]), page)
  const sent = []
  const send = async (_url, options) => {
    sent.push([...options.body])
    if (sent.length === 1) throw new Error('connection lost')
    return new Response(null, { status: 201 })
  }
  await assert.rejects(resumeInitialization(scope, store, 'token', { send }), /connection lost/)
  await resumeInitialization(scope, new IndexedDbInitializationStore('vault', open), 'token', { send })
  assert.deepEqual(sent, [[3, 4], [3, 4]])
})

test('native bridge binds the vault and checks returned bytes and freezes', async () => {
  let active = true, saved = null
  const bridge = {
    active: () => active,
    load: async () => saved,
    prepare: async (_scope, bytes) => { saved = [...bytes]; return saved },
  }
  const store = new NativeInitializationStore('vault', bridge)
  const input = new Uint8Array([4, 5])
  await store.prepare(scope, input, page)
  input[0] = 9
  assert.deepEqual(await store.load(scope), new Uint8Array([4, 5]))
  await assert.rejects(store.load({ ...scope, vaultId: 'other' }), /vault unavailable/)
  bridge.prepare = async () => [3]
  await assert.rejects(store.prepare(scope, new Uint8Array([4]), page), /different bytes/)
  bridge.load = async () => { active = false; return saved }
  await assert.rejects(store.load(scope), /vault unavailable/)
})

test('a changed saved page prevents initial preparation without creating a record', async () => {
  const open = database(), store = new IndexedDbInitializationStore('vault', open)
  await assert.rejects(store.prepare(scope, new Uint8Array([1]), { ...page, title: 'stale' }), /page changed/)
  assert.equal(await store.load(scope), null)
  await store.prepare(scope, new Uint8Array([1]), page)
  const db = await open(), tx = db.transaction('pages', 'readwrite')
  tx.objectStore('pages').put({ ...page, title: 'newer' })
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject })
  // Do not import the old snapshot after a local edit until reconciliation exists.
  await assert.rejects(store.prepare(scope, new Uint8Array([1]), page), /page changed/)
  assert.deepEqual(await store.load(scope), new Uint8Array([1]))
})
