import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { documentRevision } from '../spike/tiptap/src/documents/revision.ts'
import { operationFingerprint } from '../spike/tiptap/src/documents/operations.ts'

const digest = async value => createHash('sha256').update(value).digest('hex')
const page = (id = 'note') => ({ id, parentId: null, title: 'فارسی', tags: ['original'], favorite: false, sort: 0,
  content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'before' }] }] }, updatedAt: 1, deletedAt: null })
const host = () => ({ now: () => 42, createId: () => 'generated', defer: () => () => {}, emit() {}, report() {} })
let sequence = 0
function adapters(backend) {
  if (backend === 'memory') { const store = new MemoryDocumentStorage('fixed'); return [store, store] }
  const name = `receipt-${++sequence}`
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pages', { keyPath: 'id' })
      req.result.createObjectStore('kv')
      req.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return [new IndexedDbDocumentStorage('fixed', open), new IndexedDbDocumentStorage('fixed', open)]
}
const seed = (store, pages) => store.save({ upserts: pages, removed: [], replaceAll: true, baseVersions: {} })
const request = (kind, operationId, documentId = null, expectedRevision = null) => ({ scopeId: 'grant', operationId, kind, documentId, expectedRevision, payload: { text: ' appended', metadata: { tags: [] } } })
async function record(req, before, after) {
  return { format: 1, scopeId: req.scopeId, operationId: req.operationId, fingerprint: await operationFingerprint(req, digest), before, after,
    receipt: { operationId: req.operationId, documentId: after.id, committedAt: 42, beforeRevision: before ? await documentRevision(before, digest) : null, revision: await documentRevision(after, digest) } }
}

for (const backend of ['memory', 'indexeddb']) {
  test(`${backend}: lost response and restart return the original receipt without replaying append over newer edits`, async () => {
    const [store, reopened] = adapters(backend), before = page()
    await seed(store, [before])
    const service = new DocumentService({ storage: store, host: host() }); await service.init()
    const after = structuredClone(before); after.content.content[0].content[0].text += ' appended'; after.tags = []; after.updatedAt++
    const req = request('edit', 'append', before.id, await documentRevision(before, digest))
    const commit = store.commitOperation.bind(store)
    store.commitOperation = async input => { await commit(input); throw new Error('response lost') }
    await assert.rejects(service.commitRetriableDocument(req, before, after, digest), /response lost/)
    const original = await reopened.findOperation(req.scopeId, req.operationId)
    assert.deepEqual(original.before, before); assert.deepEqual(original.after, after)
    assert.deepEqual(original.receipt.revision, await documentRevision(after, digest))
    // A later ordinary UI save must survive the original append retry.
    const later = { ...after, title: 'human later edit', updatedAt: 3 }
    await reopened.save({ upserts: [later], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { note: after } })
    const restarted = new DocumentService({ storage: reopened, host: host() }); await restarted.init()
    restarted.setEditorDirty(before.id, true)
    assert.deepEqual(await restarted.commitRetriableDocument(req, before, after, digest), original.receipt)
    assert.deepEqual(await restarted.operationReceipt(req, digest), original.receipt)
    assert.deepEqual(await reopened.load(), [later])
    await assert.rejects(restarted.operationReceipt({ ...req, payload: { text: 'different' } }, digest), /different payload/)
    const changedRevision = { ...req, expectedRevision: await documentRevision(later, digest) }
    await assert.rejects(restarted.operationReceipt(changedRevision, digest), /different payload/)
    const copy = await reopened.findOperation(req.scopeId, req.operationId); copy.before.title = 'tampered'
    assert.equal((await reopened.findOperation(req.scopeId, req.operationId)).before.title, before.title)
    assert.deepEqual(restarted.dump(), [later]) // receipts/snapshots are absent from exported page images
  })

  test(`${backend}: concurrent create retries keep one identity; stale revisions and reused payloads cannot write`, async () => {
    const [a, b] = adapters(backend), req = request('create', 'create-once')
    const first = await record(req, null, page('generated-a')), second = await record(req, null, page('generated-b'))
    const [left, right] = await Promise.all([a.commitOperation(first), b.commitOperation(second)])
    assert.deepEqual(left, right)
    assert.equal((await b.load()).length, 1)
    assert.equal((await b.load())[0].id, left.documentId)
    const saved = await b.findOperation(req.scopeId, req.operationId)
    const different = await record({ ...req, payload: 'changed' }, null, page('generated-c'))
    await assert.rejects(a.commitOperation(different), /different payload/)
    const stale = await record(request('edit', 'stale', saved.after.id, 'r1:stale'), { ...saved.after, title: 'stale' }, { ...saved.after, title: 'overwrite' })
    await assert.rejects(b.commitOperation(stale), /revision conflict/)
    assert.equal(await b.findOperation('grant', 'stale'), null)
    const isolated = await record({ ...req, scopeId: 'other-grant' }, null, page('another-note'))
    await b.commitOperation(isolated)
    assert.equal((await a.load()).length, 2)
    await assert.rejects(a.commitOperation({ ...saved, operationId: '../escape' }), /identity/)
    const service = new DocumentService({ storage: b, host: host() }); await service.init()
    assert.deepEqual(await service.commitRetriableDocument(req, null, page('unused-new-id'), digest), left)
    assert.equal((await b.load()).length, 2)
  })
}

test('indexeddb: a failure after staging the page aborts both the page and private receipt; retry succeeds', async () => {
  const [store, reopened] = adapters('indexeddb'), before = page(), after = { ...before, title: 'saved' }
  await seed(store, [before])
  const input = await record(request('edit', 'atomic', before.id, await documentRevision(before, digest)), before, after)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === 'kv' && String(key).startsWith('document-operation/')) throw new Error('disk full')
    return put.call(this, value, key)
  }
  try { await assert.rejects(store.commitOperation(input), /disk full/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual(await reopened.load(), [before])
  assert.equal(await reopened.findOperation('grant', 'atomic'), null)
  assert.deepEqual(await reopened.commitOperation(input), input.receipt)
  assert.deepEqual(await store.load(), [after])
})
