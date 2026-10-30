import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { NativeDocumentStorage } from '../spike/tiptap/src/platform/documents/native.ts'

const page = (id = 'doc', content = { type: 'doc', content: [{ type: 'paragraph', attrs: { dir: 'rtl' }, content: [{ type: 'text', text: 'سلام' }] }] }) =>
  ({ id, parentId: null, title: 'note', content, favorite: false, sort: 0, updatedAt: 1, deletedAt: null })
function setup(pages) {
  const store = { pages: structuredClone(pages), stamp: 'initial', writes: [], fail: false }
  const storage = new NativeDocumentStorage('test-vault', {
    active: () => true, currentVaultId: async () => 'fixed-vault',
    load: async () => structuredClone(store.pages), stamp: async () => store.stamp,
    listVersions: async () => [], addVersion: async () => {}, deleteVersions: async () => {},
    async save(upserts, removed, full) {
      if (store.fail) throw Error('synthetic persistence failure')
      store.writes.push(structuredClone(upserts))
      const byId = new Map((full ? [] : store.pages).map(p => [p.id, p]))
      for (const page of upserts) { const { _base, ...saved } = page; byId.set(page.id, structuredClone(saved)) }
      for (const id of removed) byId.delete(id)
      store.pages = [...byId.values()]
      store.stamp += '!'
    },
  })
  let nextId = 0
  const host = {
    now: () => 1000, createId: () => 'copy-' + ++nextId,
    defer(task) { const timer = setTimeout(task, 0); return () => clearTimeout(timer) },
    emit() {}, report() {},
  }
  store.service = () => new DocumentService({ storage, host })
  return store
}

test('repository persists one-time migration and reloads identical IDs after restart', async () => {
  const legacy = page()
  legacy.recordMeta = { revision: 7 }
  const store = setup([legacy])
  const repo = store.service()
  await repo.init()
  assert.equal(store.writes.length, 1)
  assert.equal(store.writes[0][0]._base, 1)
  assert.equal(repo.get('doc').content.attrs.blockIdentityVersion, 1)
  assert.equal(repo.get('doc').recordMeta.revision, 8)
  const saved = JSON.stringify(repo.get('doc').content)
  const restarted = store.service()
  await restarted.init()
  assert.equal(store.writes.length, 1)
  assert.equal(JSON.stringify(restarted.get('doc').content), saved)
})

test('repository handles sync legacy input, restore and copied pages', async () => {
  const store = setup([page()])
  const repo = store.service()
  await repo.init()
  const original = structuredClone(repo.get('doc').content)
  const copy = repo.create(null)
  repo.update(copy.id, { content: original }, { copyContent: true })
  await repo.flushed()
  assert.notEqual(repo.get(copy.id).content.content[0].attrs.blockId, original.content[0].attrs.blockId)
  store.pages.push(page('synced'))
  store.stamp = 'external'
  assert.equal(await repo.refreshFromStore(), true)
  await repo.flushed()
  assert.ok(store.pages.find(p => p.id === 'synced').content.content[0].attrs.blockId)
  repo.restore([page('restored')])
  await repo.flushed()
  assert.equal(store.pages[0].id, 'restored')
  assert.ok(store.pages[0].content.content[0].attrs.blockId)
})

test('migration write failures remain pending and retry without changing IDs', async () => {
  const store = setup([page()])
  store.fail = true
  const repo = store.service()
  const log = console.error
  console.error = () => {}
  try { await repo.init() } finally { console.error = log }
  const pending = JSON.stringify(repo.get('doc').content)
  store.fail = false
  await repo.flushBeforeUpdate()
  assert.equal(JSON.stringify(store.pages[0].content), pending)
})

test('future identity versions are retained without migration or body overwrite', async () => {
  const future = page('future', { type: 'doc', attrs: { blockIdentityVersion: 2 }, content: [{ type: 'paragraph' }] })
  const store = setup([future])
  const repo = store.service()
  await repo.init()
  assert.equal(store.writes.length, 0)
  assert.throws(() => repo.update('future', { content: future.content }), /Unsupported/)
  assert.throws(() => repo.update('future', { content: { type: 'doc', content: [] } }), /Unsupported/)
  assert.deepEqual(store.pages[0], future)
})
