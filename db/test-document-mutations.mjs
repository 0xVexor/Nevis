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
const runtime = { digest }
const body = () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'فارسی created' }] }] })
const initial = (id = 'parent') => ({ id, parentId: null, kind: 'folder', title: 'Parent', favorite: false, tags: [], sort: 1, updatedAt: 1, deletedAt: null,
  content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1' } }] } })
const create = (extra = {}) => ({ operationId: 'create', parentId: 'parent', kind: 'page', metadata: { title: '', tags: [], favorite: false }, content: body(), ...extra })
const access = () => ({ context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => true,
  canRead: id => id !== 'hidden', canWrite: id => id !== 'hidden', canCreate: () => true })
function host(prefix = 'generated') { let counter = 0; const events = []
  return { events, now: () => 42, createId: () => `${prefix}_${++counter}`, defer: () => () => {}, report() {},
    emit: (event, detail) => events.push({ event, detail })}
}
let sequence = 0
function storage(backend) {
  if (backend === 'memory') return new MemoryDocumentStorage('fixed')
  const name = `mutations-${++sequence}`
  return new IndexedDbDocumentStorage('fixed', () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('pages', { keyPath: 'id' }); request.result.createObjectStore('kv'); request.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId') }
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  }))
}
const seed = (store, pages) => store.save({ upserts: pages, removed: [], replaceAll: true, baseVersions: {} })
const ajv = new Ajv({ strict: true }), validators = Object.fromEntries(['create_document', 'update_document_metadata'].map(name => [name, ajv.compile(documentToolContracts[name].outputSchema)]))
const valid = (tool, result) => assert.ok(validators[tool]({ ok: true, result }), JSON.stringify(validators[tool].errors))

for (const backend of ['memory', 'indexeddb']) {
  test(`${backend}: create commits one identity, appends after trashed siblings and replays after restart without new writes`, async () => {
    const store = storage(backend), parent = initial(), trashed = { ...initial('trashed'), parentId: 'parent', sort: 7, deletedAt: 12 }
    await seed(store, [parent, trashed])
    const service = new DocumentService({ storage: store, host: host() }); await service.init()
    const writer = service.editor(access(), runtime), req = create()
    const result = await writer.createDocument(req); valid('create_document', result)
    assert.equal(result.replayed, false); assert.equal(result.receipt.beforeRevision, null)
    const saved = (await store.load()).find(page => page.id === result.documentId)
    assert.equal(saved.parentId, 'parent'); assert.equal(saved.sort, 8)
    assert.equal(saved.title, ''); assert.deepEqual(saved.tags, []); assert.equal(saved.favorite, false)
    assert.equal(saved.content.attrs.blockIdentityVersion, 1)
    assert.ok(saved.content.content[0].attrs.blockId.startsWith('m1_'))
    assert.equal(result.revision, await documentRevision(saved, digest))
    assert.deepEqual(result.metadata, { title: '', tags: [], favorite: false, icon: null, titleDir: null, status: null })
    assert.equal((await store.listVersions(saved.id)).length, 0)
    assert.deepEqual((await store.load()).find(page => page.id === 'parent'), parent)
    const restarted = new DocumentService({ storage: store, host: host('different') }); await restarted.init()
    const replay = await restarted.editor(access(), runtime).createDocument(req); valid('create_document', replay)
    assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, result.receipt); assert.equal(replay.documentId, result.documentId)
    assert.equal((await store.load()).length, 3)
    await assert.rejects(writer.createDocument({ ...req, metadata: { ...req.metadata, title: 'changed' } }), { code: 'OPERATION_ID_MISMATCH' })
    const folder = await writer.createDocument(create({ operationId: 'folder', kind: 'folder', content: { type: 'doc', content: [{ type: 'paragraph' }] } })); valid('create_document', folder)
    assert.equal((await store.load()).find(page => page.id === folder.documentId).kind, 'folder')
    const todo = await writer.createDocument(create({ operationId: 'todo', kind: 'todo', parentId: null, content: { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] }] } })); valid('create_document', todo)
    assert.equal((await store.load()).find(page => page.id === todo.documentId).kind, 'todo')
  })

  test(`${backend}: metadata is revision-gated, preserves body/extensions, and distinguishes omitted, null and empty values`, async () => {
    const store = storage(backend), original = { ...initial('note'), kind: 'page', title: 'oldtitle', tags: ['oldtag'], favorite: true, icon: 'icon', titleDir: 'rtl', status: 'doing',
      cover: { kind: 'gradient', id: 'keep' }, content: '<p dir="rtl">legacy HTML untouched</p>' }
    const link = { ...initial('linker'), kind: 'page', content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'link-p' }, content: [{ type: 'pageLink', attrs: { id: 'note', label: null } }] }] } }
    await seed(store, [original, link])
    const h = host(), service = new DocumentService({ storage: store, host: h }); await service.init()
    const writer = service.editor(access(), runtime), req = { operationId: 'metadata', documentId: 'note', expectedRevision: await documentRevision(original, digest), patch: { title: 'newtitle', tags: [] } }
    const result = await writer.updateDocumentMetadata(req); valid('update_document_metadata', result)
    const saved = (await store.load()).find(page => page.id === 'note')
    assert.equal(saved.content, original.content); assert.deepEqual(saved.cover, original.cover)
    assert.equal(saved.icon, original.icon); assert.equal(saved.titleDir, 'rtl'); assert.equal(saved.status, 'doing'); assert.equal(saved.favorite, true)
    assert.deepEqual(result.metadata.tags, []); assert.equal(result.metadata.title, 'newtitle')
    assert.equal((await service.searchPersisted('newtitle'))[0].id, 'note'); assert.deepEqual(await service.searchPersisted('oldtag'), [])
    assert.equal(service.backlinks('note')[0].id, 'linker')
    assert.ok(h.events.some(e => e.event === 'external-change' && e.detail.includes('note')))
    const cleared = await writer.updateDocumentMetadata({ operationId: 'clear', documentId: 'note', expectedRevision: result.revision,
      patch: { title: '', tags: [], favorite: false, icon: null, titleDir: null, status: null } }); valid('update_document_metadata', cleared)
    const current = service.get('note')
    assert.equal(current.title, ''); assert.equal(current.favorite, false)
    for (const key of ['icon', 'titleDir', 'status']) assert.equal(Object.hasOwn(current, key), false)
    assert.equal(current.content, original.content)
    const replay = await writer.updateDocumentMetadata(req)
    assert.equal(replay.replayed, true); assert.deepEqual(replay.metadata, result.metadata); assert.deepEqual(replay.receipt, result.receipt)
    assert.equal(service.get('note').title, '')
    await assert.rejects(writer.updateDocumentMetadata({ ...req, operationId: 'stale' }), { code: 'REVISION_CONFLICT' })
    for (const patch of [{}, { cover: { kind: 'invalid' } }, { parentId: null }, { content: {} }, { tags: ['duplicate', 'duplicate'] }, { icon: '' }, { status: 'other' }]) {
      await assert.rejects(writer.updateDocumentMetadata({ ...req, operationId: 'invalid', patch }), { code: 'INVALID_ARGUMENT' })
    }
    assert.equal((await store.listVersions('note')).length, 2)
    assert.deepEqual((await store.findOperation('grant', 'metadata')).before, original)
  })
}

test('creation scope, unsupported content, parent races and concurrent duplicate creates never bypass atomic placement', async () => {
  const store = storage('indexeddb'), parent = initial(); await seed(store, [parent])
  const a = new DocumentService({ storage: store, host: host('a') }), b = new DocumentService({ storage: store, host: host('b') })
  await a.init(); await b.init()
  const req = create(), results = await Promise.all([a.editor(access(), runtime).createDocument(req), b.editor(access(), runtime).createDocument(req)])
  assert.equal(results[0].documentId, results[1].documentId)
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]); assert.equal((await store.load()).length, 2)
  assert.ok(a.get(results[0].documentId)); assert.ok(b.get(results[0].documentId))
  const denied = access(); delete denied.canCreate
  await assert.rejects(a.editor(denied, runtime).createDocument(create({ operationId: 'denied' })), { code: 'ACCESS_DENIED' })
  for (const [extra, code] of [
    [{ parentId: 'hidden' }, 'ACCESS_DENIED'], [{ parentId: 'missing' }, 'INVALID_TARGET'],
    [{ kind: 'board' }, 'UNSUPPORTED_CONTENT'], [{ kind: 'folder' }, 'UNSUPPORTED_CONTENT'],
    [{ content: { type: 'doc', content: [{ type: 'futureWidget' }] } }, 'UNSUPPORTED_CONTENT'],
    [{ content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: 'hidden', label: 'hidden' } }] }] } }, 'ACCESS_DENIED'],
  ]) await assert.rejects(a.editor(access(), runtime).createDocument(create({ operationId: 'invalid', ...extra })), { code })
  assert.equal((await store.load()).length, 2)
  const commit = store.commitOperationResult.bind(store)
  store.commitOperationResult = async record => {
    const currentParent = (await store.load()).find(page => page.id === 'parent')
    await store.save({ upserts: [{ ...currentParent, deletedAt: 99 }], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { parent: currentParent } })
    return commit(record)
  }
  await assert.rejects(a.editor(access(), runtime).createDocument(create({ operationId: 'parent-race' })), { code: 'REVISION_CONFLICT' })
  assert.equal(await store.findOperation('grant', 'parent-race'), null)
  assert.equal((await store.load()).length, 2)
  store.commitOperationResult = commit
  const trashed = (await store.load()).find(page => page.id === 'parent')
  await store.save({ upserts: [parent], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { parent: trashed } })
  store.commitOperationResult = async record => {
    const sibling = { ...initial('new-sibling'), parentId: 'parent', sort: 99 }
    await store.save({ upserts: [sibling], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { 'new-sibling': null } })
    return commit(record)
  }
  await assert.rejects(a.editor(access(), runtime).createDocument(create({ operationId: 'sibling-race' })), { code: 'REVISION_CONFLICT' })
  assert.equal(await store.findOperation('grant', 'sibling-race'), null)
  store.commitOperationResult = async record => { await commit(record); throw new Error('response lost') }
  const lost = create({ operationId: 'lost', parentId: null })
  await assert.rejects(a.editor(access(), runtime).createDocument(lost), { code: 'PERSISTENCE_FAILED' })
  store.commitOperationResult = commit
  const recovered = await a.editor(access(), runtime).createDocument(lost); valid('create_document', recovered)
  assert.equal(recovered.replayed, true)
  assert.equal((await store.load()).filter(page => page.id === recovered.documentId).length, 1)
})
