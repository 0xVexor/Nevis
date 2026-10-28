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
import { DOCUMENT_HISTORY_LIFETIME_MS } from '../spike/tiptap/src/documents/operations.ts'
const digest = async value => createHash('sha256').update(value).digest('hex')
const page = () => ({ id: 'note', parentId: null, title: 'فارسی', icon: 'old', tags: ['keep'], favorite: false, sort: 0, updatedAt: 1, deletedAt: null,
  content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1', dir: 'rtl' }, content: [{ type: 'text', text: 'retained فارسی' }] }] } })
const grant = () => ({ context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => true,
  canRead: id => ['note', 'created'].includes(id), canWrite: id => ['note', 'created'].includes(id), canCreate: id => id === null })
let number = 0
async function setup(backend = 'memory') {
  let now = 100, ids = 0
  const host = { now: () => now, createId: () => `cursor-${++ids}`, defer: () => () => {}, emit() {}, report() {}, syncState: () => 'disabled' }
  let store
  if (backend === 'memory') store = new MemoryDocumentStorage('fixed')
  else {
    const name = `history-${++number}`
    const open = () => new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('pages', { keyPath: 'id' }); req.result.createObjectStore('kv'); req.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId') }
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    })
    store = new IndexedDbDocumentStorage('fixed', open)
  }
  await store.save({ upserts: [page()], removed: [], replaceAll: true, baseVersions: {} })
  const service = new DocumentService({ storage: store, host }); await service.init()
  return { store, service, host, setNow: value => { now = value }, editor: service.editor(grant(), { digest }) }
}
const schemas = Object.fromEntries(['get_document_history', 'undo_document_edit'].map(name => [name, new Ajv({ strict: true }).compile(documentToolContracts[name].outputSchema)]))
function valid(tool, result) { assert.ok(schemas[tool]({ ok: true, result }), JSON.stringify(schemas[tool].errors)) }
async function rename(editor, before = page(), op = 'rename') {
  return editor.updateDocumentMetadata({ documentId: before.id, operationId: op, expectedRevision: await documentRevision(before, digest), patch: { title: 'new title', icon: null, tags: [] } })
}
for (const backend of ['memory', 'indexeddb']) test(`${backend}: retained full snapshots survive restart; preview/apply undo preserves identity and replays once`, async () => {
  const { store, service, host, editor, setNow } = await setup(backend)
  const edit = await rename(editor)
  const restarted = new DocumentService({ storage: store, host }); await restarted.init()
  const history = restarted.editor(grant(), { digest })
  const listed = await history.getDocumentHistory({ documentId: 'note', limit: 1 }); valid('get_document_history', listed)
  assert.equal(listed.versions[0].versionId, 'after:rename'); assert.ok(listed.nextCursor)
  const more = await history.getDocumentHistory({ documentId: 'note', limit: 1, cursor: listed.nextCursor }); valid('get_document_history', more)
  assert.equal(more.versions[0].versionId, 'before:rename')
  const snapshot = await history.getDocumentHistory({ documentId: 'note', versionId: 'before:rename', format: 'structured' }); valid('get_document_history', snapshot)
  assert.equal(snapshot.retainedMetadata.icon, 'old')
  assert.deepEqual(snapshot.retainedMetadata.tags, ['keep'])
  assert.equal(snapshot.retainedContent.revision, await documentRevision(page(), digest))
  assert.deepEqual(snapshot.retainedContent.chunks[0].structured, page().content.content)
  const req = { documentId: 'note', operationId: 'undo-rename', undoOperationId: 'rename', expectedRevision: edit.revision }
  const preview = await history.undoDocumentEdit({ ...req, mode: 'preview' }); valid('undo_document_edit', preview)
  assert.equal(preview.persisted, false); assert.equal(await store.findOperation('grant', 'undo-rename'), null)
  const saved = await history.undoDocumentEdit(req); valid('undo_document_edit', saved)
  const current = (await store.load())[0]
  assert.equal(current.title, page().title); assert.equal(current.icon, 'old'); assert.deepEqual(current.tags, ['keep'])
  assert.deepEqual(current.content, page().content); assert.notEqual(saved.revision, await documentRevision(page(), digest))
  assert.equal(saved.revision, await documentRevision(current, digest)); assert.equal(saved.replayed, false)
  assert.equal(saved.metadata.title, page().title); assert.equal(saved.search.state, 'fresh')
  const undoRecord = await store.findOperation('grant', 'undo-rename')
  assert.deepEqual(undoRecord.before.content, undoRecord.after.content)
  assert.equal(undoRecord.undoOf, 'rename')
  assert.equal(undoRecord.before.title, 'new title'); assert.equal(undoRecord.after.title, page().title)
  const undoHistory = await history.getDocumentHistory({ documentId: 'note' }); assert.equal(undoHistory.versions.length, 4)
  await restarted.refreshFromStore(); restarted.update('note', { title: 'later human edit' }); await restarted.flushBeforeUpdate()
  restarted.setEditorDirty('note', true)
  const replay = await history.undoDocumentEdit(req); valid('undo_document_edit', replay)
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, saved.receipt)
  assert.equal((await store.load())[0].title, 'later human edit')
  await assert.rejects(history.undoDocumentEdit({ ...req, operationId: 'stale' }), { code: 'REVISION_CONFLICT' })
  await assert.rejects(history.undoDocumentEdit({ ...req, undoOperationId: 'undo-rename' }), { code: 'OPERATION_ID_MISMATCH' })
  restarted.setEditorDirty('note', false)
  setNow(100 + DOCUMENT_HISTORY_LIFETIME_MS)
  assert.deepEqual((await history.undoDocumentEdit(req)).receipt, saved.receipt)
  assert.equal(service.vaultHandle, 'fixed')
})

test('history and undo enforce read/write grants, expiry, snapshot-bound cursors and authorization after awaits', async () => {
  const { store, service, editor, setNow } = await setup('indexeddb')
  const edit = await rename(editor), access = grant()
  access.canWrite = () => false
  const reader = service.editor(access, { digest })
  assert.equal((await reader.getDocumentHistory({ documentId: 'note' })).versions.length, 2)
  const undo = { documentId: 'note', operationId: 'undo', undoOperationId: 'rename', expectedRevision: edit.revision }
  await assert.rejects(reader.undoDocumentEdit(undo), { code: 'ACCESS_DENIED' })
  const cursor = (await reader.getDocumentHistory({ documentId: 'note', limit: 1 })).nextCursor
  const list = store.listOperations.bind(store)
  store.listOperations = async (...args) => { const result = await list(...args); access.context.grantRevision = '2'; return result }
  await assert.rejects(reader.getDocumentHistory({ documentId: 'note' }), { code: 'ACCESS_DENIED' })
  store.listOperations = list
  const other = grant(); other.context.grantId = 'other'
  assert.deepEqual((await service.editor(other, { digest }).getDocumentHistory({ documentId: 'note' })).versions, [])
  const hidden = grant(); hidden.canRead = () => false
  await assert.rejects(service.editor(hidden, { digest }).getDocumentHistory({ documentId: 'note', versionId: 'before:rename' }), { code: 'ACCESS_DENIED' })
  setNow(100 + DOCUMENT_HISTORY_LIFETIME_MS)
  assert.equal((await editor.getDocumentHistory({ documentId: 'note' })).versions.length, 0)
  await assert.rejects(editor.getDocumentHistory({ documentId: 'note', versionId: 'before:rename' }), { code: 'VERSION_EXPIRED' })
  await assert.rejects(editor.undoDocumentEdit(undo), { code: 'VERSION_EXPIRED' })
  // Expiry hides snapshots, but preserves the original retry result.
  assert.equal((await rename(editor)).replayed, true)
  assert.ok(await store.findOperation('grant', 'rename'))
  assert.ok(cursor)
})

test('undo failures leave no operation; dirty drafts and storage races cannot overwrite later content', async () => {
  const { store, service, editor } = await setup('indexeddb')
  const edit = await rename(editor)
  const req = { documentId: 'note', operationId: 'undo', undoOperationId: 'rename', expectedRevision: edit.revision }
  service.setEditorDirty('note', true)
  await assert.rejects(editor.undoDocumentEdit(req), { code: 'EDITOR_BUSY' }); service.setEditorDirty('note', false)
  const commit = store.commitOperationResult.bind(store)
  store.commitOperationResult = async () => { throw Error('disk full') }
  await assert.rejects(editor.undoDocumentEdit(req), { code: 'PERSISTENCE_FAILED' })
  assert.equal(await store.findOperation('grant', 'undo'), null)
  store.commitOperationResult = async record => {
    const current = (await store.load())[0]
    await store.save({ upserts: [{ ...current, title: 'same-time external edit' }], removed: [], replaceAll: false, baseVersions: {} })
    return commit(record)
  }
  await assert.rejects(editor.undoDocumentEdit(req), { code: 'REVISION_CONFLICT' })
  assert.equal((await store.load())[0].title, 'same-time external edit'); assert.equal(await store.findOperation('grant', 'undo'), null)
  assert.equal(service.isWriteLocked(), false)
})

test('undo creation uses a tombstone and atomically refuses children added during commit', async () => {
  const { store, service, editor, host } = await setup('indexeddb')
  host.createId = () => 'created'
  const created = await editor.createDocument({ operationId: 'create', parentId: null, kind: 'page', metadata: { title: 'created', tags: [], favorite: false }, content: { type: 'doc', content: [{ type: 'paragraph' }] } })
  const req = { documentId: 'created', operationId: 'undo-create', undoOperationId: 'create', expectedRevision: created.revision }
  const commit = store.commitOperationResult.bind(store)
  store.commitOperationResult = async record => { await store.save({ upserts: [{ ...page(), id: 'child', parentId: 'created' }], removed: [], replaceAll: false, baseVersions: {} }); return commit(record) }
  await assert.rejects(editor.undoDocumentEdit(req), { code: 'REVISION_CONFLICT' })
  store.commitOperationResult = commit
  await store.save({ upserts: [], removed: ['child'], replaceAll: false, baseVersions: {} })
  const saved = await editor.undoDocumentEdit(req); valid('undo_document_edit', saved)
  assert.ok((await store.load()).find(page => page.id === 'created').deletedAt)
  const retained = await editor.getDocumentHistory({ documentId: 'created', versionId: 'after:undo-create', format: 'structured' }); valid('get_document_history', retained)
  assert.equal(retained.retainedContent.revision, saved.revision)
  assert.equal(service.get('created'), undefined)
})

test('retention caps visible operations, cursor changes fail explicitly, and undo restores full rich content', async () => {
  const { store, service, editor } = await setup('memory')
  const first = await rename(editor)
  const cursor = (await editor.getDocumentHistory({ documentId: 'note', limit: 1 })).nextCursor
  const current = (await store.load())[0]
  const changed = await editor.editDocument({ documentId: 'note', operationId: 'body', expectedRevision: first.revision, mode: 'apply', operations: [
    { kind: 'set_attributes', target: { blockId: 'p1' }, attributes: { dir: 'ltr' } },
  ] })
  await assert.rejects(editor.getDocumentHistory({ documentId: 'note', limit: 1, cursor }), { code: 'STALE_CURSOR' })
  const undo = await editor.undoDocumentEdit({ documentId: 'note', operationId: 'undo-body', undoOperationId: 'body', expectedRevision: changed.saved.revision })
  assert.deepEqual((await store.load())[0].content, current.content)
  assert.equal(undo.savedContent.chunks[0].structured[0].attrs.dir, 'rtl')
  const record = await store.findOperation('grant', 'undo-body')
  // Keep receipts and snapshots on disk, while exposing only the newest 40 operations.
  for (let i = 0; i < 41; i++) {
    const before = (await store.load())[0], after = { ...before, updatedAt: before.updatedAt + 1 }
    const operationId = `retained-${String(i).padStart(2, '0')}`
    await store.commitOperationResult({ ...record, operationId, before, after,
      receipt: { ...record.receipt, operationId, beforeRevision: await documentRevision(before, digest), revision: await documentRevision(after, digest), committedAt: 101 + i }, history: undefined })
  }
  const summary = await store.listOperations('grant', 'note'); assert.equal(summary.length, 40)
  assert.equal(summary[0].operationId, 'retained-40'); assert.equal(summary.at(-1).operationId, 'retained-01')
  assert.equal((await editor.getDocumentHistory({ documentId: 'note', limit: 100 })).versions.length, 80)
  await assert.rejects(editor.getDocumentHistory({ documentId: 'note', versionId: 'before:rename' }), { code: 'VERSION_EXPIRED' })
  assert.ok(await store.findOperation('grant', 'rename'))
  await assert.rejects(editor.getDocumentHistory({ documentId: 'note', limit: 0 }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(editor.getDocumentHistory({ documentId: 'note', budget: { maxChars: 0, maxBlocks: 1 } }), { code: 'INVALID_ARGUMENT' })
  assert.equal(service.isWriteLocked(), false)
})
