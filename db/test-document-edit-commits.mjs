import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'
import { documentRevision } from '../spike/tiptap/src/documents/revision.ts'
import { documentToolContracts } from '../spike/tiptap/src/documents/contracts.ts'

const digest = async value => createHash('sha256').update(value).digest('hex')
const runtime = { digest, now: () => 42, cursorId: () => 'cursor' }
const page = () => ({ id: 'note', parentId: null, title: 'فارسی', tags: ['keep'], favorite: false, sort: 1, updatedAt: 1, deletedAt: null,
  content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1', dir: 'rtl', textAlign: 'right' }, content: [{ type: 'text', text: 'before' }] }] } })
const target = () => ({ ...page(), id: 'destination', content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'd1' } }] } })
let number = 0
function storage(backend) {
  if (backend === 'memory') return new MemoryDocumentStorage('fixed')
  const name = `edit-commits-${++number}`
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pages', { keyPath: 'id' }); req.result.createObjectStore('kv')
      req.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
    }
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
  })
  return new IndexedDbDocumentStorage('fixed', open)
}
const seed = (store, pages) => store.save({ upserts: pages, removed: [], replaceAll: true, baseVersions: {} })
function host() {
  const events = [], errors = []
  return { events, errors, now: () => 42, createId: () => 'generated', defer: () => () => {},
    emit: (event, detail) => events.push({ event, detail }), report: (context, error) => errors.push({ context, error }), syncState: () => 'disabled' }
}
const grant = () => ({ context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => true,
  canRead: id => ['note', 'destination'].includes(id), canWrite: id => id === 'note' })
const request = async (source = page(), extra = {}) => ({ documentId: source.id, expectedRevision: await documentRevision(source, digest), operationId: 'edit-once', mode: 'apply',
  operations: [{ kind: 'insert_blocks', at: { position: 'end', parent: null }, blocks: [{ temporaryId: 'new', node: { type: 'paragraph', content: [{ type: 'text', text: 'new Persian فارسی' }] } }] },
    { kind: 'set_internal_link', target: { temporaryId: 'new' }, destinationDocumentId: 'destination', label: 'پیوند' }], ...extra })
const output = new Ajv({ strict: true }).compile(documentToolContracts.edit_document.outputSchema)
const valid = result => assert.ok(output({ ok: true, result }), JSON.stringify(output.errors))

for (const backend of ['memory', 'indexeddb']) {
  test(`${backend}: preview/apply commit once with history, exact read-back, links, freshness and original retry evidence`, async () => {
    const store = storage(backend), before = page(), h = host()
    await seed(store, [before, target()])
    const service = new DocumentService({ storage: store, host: h }); await service.init()
    const editor = service.editor(grant(), runtime), req = await request()
    let count = 0
    const commit = store.commitOperationResult.bind(store)
    store.commitOperationResult = async record => { count++; assert.equal(service.isWriteLocked(), true); return commit(record) }
    const preview = await editor.editDocument({ ...req, mode: 'preview' }); valid(preview)
    assert.equal(count, 0); assert.equal((await store.listVersions('note')).length, 0)
    assert.deepEqual((await store.load()).find(p => p.id === 'note'), before)
    const result = await editor.editDocument(req); valid(result)
    assert.equal(result.saved.replayed, false); assert.equal(result.saved.sync, 'disabled')
    assert.equal(result.saved.search.state, 'fresh'); assert.equal(count, 1)
    const durable = (await store.load()).find(p => p.id === 'note')
    assert.equal(result.saved.revision, await documentRevision(durable, digest))
    assert.equal(durable.updatedAt, 42)
    assert.deepEqual(durable.content.content[0], before.content.content[0])
    assert.deepEqual(service.get('note'), durable)
    assert.ok(service.backlinks('destination').some(p => p.id === 'note'))
    assert.ok(h.events.some(e => e.event === 'external-change' && e.detail.includes('note')))
    const versions = await store.listVersions('note')
    assert.equal(versions.length, 1); assert.deepEqual(versions[0].content, before.content)
    // The first UI history snapshot in the same clock tick must not overwrite the operation pre-image.
    await store.addVersion({ pageId: 'note', ts: versions[0].ts, title: durable.title, content: durable.content })
    await store.addVersion({ pageId: 'note', ts: versions[0].ts, title: durable.title, content: durable.content })
    assert.equal((await store.listVersions('note')).length, 2)
    assert.ok((await store.listVersions('note')).some(v => JSON.stringify(v.content) === JSON.stringify(before.content)))
    assert.equal(service.isWriteLocked(), false)
    const blockId = result.saved.savedContent.chunks[0].range.fromBlockId
    const read = await service.reader(grant(), runtime).readDocument({ documentId: 'note', expectedRevision: result.saved.revision,
      target: { kind: 'blocks', blockIds: [blockId] }, format: 'structured' })
    assert.deepEqual(read.chunks[0].structured, result.saved.savedContent.chunks[0].structured)
    assert.equal(JSON.parse(preview.changes[0].after)[0].attrs.blockId, blockId)
    // Later UI edits and a fresh dirty editor must survive a replay of the earlier committed operation.
    service.update('note', { title: 'later human edit' }); await service.flushBeforeUpdate()
    service.setEditorDirty('note', true)
    const replay = await editor.editDocument(req); valid(replay)
    assert.equal(replay.saved.replayed, true)
    assert.deepEqual(replay.saved.receipt, result.saved.receipt)
    assert.deepEqual(replay.saved.savedContent, result.saved.savedContent)
    assert.equal(replay.saved.search.state, 'pending') // original revision is no longer the indexed version
    assert.equal(service.get('note').title, 'later human edit'); assert.equal(count, 1)
    await assert.rejects(editor.editDocument({ ...req, budget: { maxChars: 1, maxBlocks: 1 } }), { code: 'OPERATION_ID_MISMATCH' })
    const latest = (await store.load()).find(p => p.id === 'note')
    await assert.rejects(editor.editDocument(await request(latest, { operationId: 'busy' })), { code: 'EDITOR_BUSY' })
    service.setEditorDirty('note', false)
    await assert.rejects(editor.editDocument({ ...req, operationId: 'stale' }), { code: 'REVISION_CONFLICT' })
    assert.equal((await store.listVersions('note')).length, 2)
  })
}

test('concurrent identical commits return one original receipt and one history entry with accurate replay flags', async () => {
  const store = storage('indexeddb'); await seed(store, [page(), target()])
  const a = new DocumentService({ storage: store, host: host() }), b = new DocumentService({ storage: store, host: host() })
  await a.init(); await b.init()
  const req = await request(), results = await Promise.all([a.editor(grant(), runtime).editDocument(req), b.editor(grant(), runtime).editDocument(req)])
  results.forEach(valid)
  assert.deepEqual(results[0].saved.receipt, results[1].saved.receipt)
  assert.deepEqual(results.map(r => r.saved.replayed).sort(), [false, true])
  assert.equal((await store.listVersions('note')).length, 1)
  assert.equal((await store.load()).find(p => p.id === 'note').content.content.length, 2)
})

test('save survives index/sync/observer failure and lost response; history failures atomically abort pages and receipts', async () => {
  const store = storage('indexeddb'), h = host(); await seed(store, [page(), target()])
  let service
  h.syncState = () => { assert.equal(service.isWriteLocked(), false); throw new Error('sync status unavailable') }
  const emit = h.emit; h.emit = (event, detail) => { if (event === 'external-change') throw new Error('observer'); emit(event, detail) }
  service = new DocumentService({ storage: store, host: h, search: { build: () => { assert.equal(service.isWriteLocked(), false); throw new Error('index failure') } } })
  await service.init()
  const editor = service.editor(grant(), runtime), req = await request()
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value, key) { if (this.name === 'versions') throw new Error('history disk full'); return put.call(this, value, key) }
  try { await assert.rejects(editor.editDocument(req), { code: 'PERSISTENCE_FAILED' }) }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual((await store.load()).find(p => p.id === 'note'), page()); assert.equal(await store.findOperation('grant', 'edit-once'), null)
  assert.equal((await store.listVersions('note')).length, 0)
  const commit = store.commitOperationResult.bind(store)
  store.commitOperationResult = async record => { await commit(record); throw new Error('lost response') }
  await assert.rejects(editor.editDocument(req), { code: 'PERSISTENCE_FAILED' })
  store.commitOperationResult = commit
  assert.equal(service.get('note').content.content.length, 1)
  const recovered = await editor.editDocument(req); valid(recovered)
  assert.equal(recovered.saved.replayed, true)
  assert.equal(service.get('note').content.content.length, 2)
  const restarted = new DocumentService({ storage: store, host: h, search: { build: () => { throw new Error('index failure') } } }); await restarted.init()
  const replay = await restarted.editor(grant(), runtime).editDocument(req); valid(replay)
  assert.equal(replay.saved.replayed, true); assert.equal(replay.saved.search.state, 'failed'); assert.equal(replay.saved.sync, 'pending')
  assert.equal((await store.listVersions('note')).length, 1)
  const before = (await store.load()).find(p => p.id === 'note')
  const fresh = await restarted.editor(grant(), runtime).editDocument(await request(before, { operationId: 'tiny-proof', budget: { maxChars: 1, maxBlocks: 1 } })); valid(fresh)
  assert.equal(fresh.saved.savedContent.truncated, true); assert.deepEqual(fresh.saved.savedContent.chunks, [])
  assert.equal(fresh.saved.search.state, 'failed'); assert.equal(restarted.isWriteLocked(), false)
  assert.equal((await store.listVersions('note')).length, 2)
})

test('grant revocation and typing during asynchronous work reject before admission; external same-timestamp writes win', async () => {
  const store = storage('memory'), h = host(); await seed(store, [page(), target()])
  const service = new DocumentService({ storage: store, host: h }); await service.init()
  const access = grant(), req = await request()
  const find = store.findOperation.bind(store)
  let calls = 0
  store.findOperation = async (...args) => { const result = await find(...args); if (++calls === 2) access.context.grantRevision = '2'; return result }
  await assert.rejects(service.editor(access, runtime).editDocument(req), { code: 'ACCESS_DENIED' })
  assert.deepEqual((await store.load())[0], page()); assert.equal((await store.listVersions('note')).length, 0)
  store.findOperation = find
  let hashes = 0
  const typingRuntime = { digest: async value => { if (++hashes === 2) service.setEditorDirty('note', true); return digest(value) } }
  await assert.rejects(service.editor(grant(), typingRuntime).editDocument(req), { code: 'EDITOR_BUSY' })
  service.setEditorDirty('note', false)
  const commit = store.commitOperationResult.bind(store)
  const external = { ...page(), title: 'external same timestamp' }
  store.commitOperationResult = async record => { await store.save({ upserts: [external], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { note: page() } }); return commit(record) }
  await assert.rejects(service.editor(grant(), runtime).editDocument(req), { code: 'REVISION_CONFLICT' })
  assert.equal((await store.load())[0].title, external.title)
  assert.equal((await store.listVersions('note')).length, 0)
  assert.equal(service.isWriteLocked(), false)
  store.commitOperationResult = commit
  await service.refreshFromStore()
  const load = store.load.bind(store)
  store.load = async () => {
    const oldRows = await load()
    service.update('note', { title: 'typed and saved while reload awaited' })
    await service.flushBeforeUpdate()
    return oldRows
  }
  assert.equal(await service.refreshFromStore(), false)
  assert.equal(service.get('note').title, 'typed and saved while reload awaited')
  assert.equal((await load()).find(p => p.id === 'note').title, service.get('note').title)
})
