import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { identifyBlocks } from '../spike/tiptap/src/documents/blockIdentity.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'
import { NativeDocumentStorage } from '../spike/tiptap/src/platform/documents/native.ts'
import { canonicalDocumentValue, documentRevision } from '../spike/tiptap/src/documents/revision.ts'
import { createHash } from 'node:crypto'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
const migrated = fixtures.map(page => ({ ...page, content: identifyBlocks(page.content).content }))
function host() {
  let next = 0, clock = 1800000000000
  const tasks = new Set()
  const events = [], errors = []
  return {
    events, errors, tasks,
    now: () => ++clock, createId: () => `page-${++next}`,
    defer(task) { tasks.add(task); return () => tasks.delete(task) },
    emit: (event, detail) => events.push({ event, detail }),
    report: (context, error) => errors.push({ context, error }),
  }
}
let databaseNumber = 0
function openDb(name = `document-contract-${++databaseNumber}`) {
  let opening
  return () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' })
      request.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
const write = (upserts, replaceAll = false) => ({ upserts, removed: [], replaceAll, baseVersions: {} })

test('document revisions cover content and metadata and ignore object key order', async () => {
  const digest = async value => createHash('sha256').update(value).digest('hex')
  const page = migrated[0]
  const revision = await documentRevision(page, digest)
  assert.equal(await documentRevision(Object.fromEntries(Object.entries(page).reverse()), digest), revision)
  assert.notEqual(await documentRevision({ ...page, title: `${page.title}!` }, digest), revision)
  assert.notEqual(await documentRevision({ ...page, content: { type: 'doc', content: [] } }, digest), revision)
  assert.equal(canonicalDocumentValue({ b: 2, a: 1 }), canonicalDocumentValue({ a: 1, b: 2 }))
  await assert.rejects(documentRevision(page, async () => 'invalid'), /digest/)
})

for (const backend of ['memory', 'indexeddb']) {
  test(`${backend}: shared UI operations preserve hierarchy, links, search, copies, trash and restart`, async () => {
    const storage = backend === 'memory' ? new MemoryDocumentStorage('fixed') : new IndexedDbDocumentStorage('fixed', openDb())
    await storage.save(write(migrated, true))
    const runtime = host()
    const service = new DocumentService({ storage, host: runtime })
    await service.init()
    assert.deepEqual(service.dump(), migrated)
    const root = service.create(null, 'folder')
    const page = service.create(root.id)
    const target = migrated.find(p => p.kind !== 'folder' && !p.deletedAt).id
    service.update(page.id, { title: 'كلاس ۱۲۳', content: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'برنامه‌نویسی' }, { type: 'pageLink', attrs: { id: target, label: 'پیوند' } },
    ] }] } })
    assert.ok(service.search('کلاس 123').some(p => p.id === page.id))
    assert.ok(service.backlinks(target).some(p => p.id === page.id))
    assert.equal(service.move(root.id, page.id, null), false)
    assert.equal(service.move(page.id, null, null), true)
    const copy = service.create(null)
    service.update(copy.id, { content: page.content }, { copyContent: true })
    assert.notEqual(copy.content.content[0].attrs.blockId, page.content.content[0].attrs.blockId)
    service.remove(copy.id)
    assert.equal(service.get(copy.id), undefined)
    service.restoreFromTrash(copy.id)
    assert.ok(service.get(copy.id))
    await service.flushBeforeUpdate()
    assert.equal(runtime.tasks.size, 0)
    const reopened = new DocumentService({ storage, host: host() })
    await reopened.init()
    assert.deepEqual(reopened.dump(), service.dump())
    service.purge(copy.id)
    await service.flushBeforeUpdate()
    assert.ok(!(await storage.load()).some(p => p.id === copy.id))
    assert.equal(service.vaultHandle, 'fixed')
  })

  test(`${backend}: history adapter retains newest 40 per document and deletes only the selected history`, async () => {
    const storage = backend === 'memory' ? new MemoryDocumentStorage('fixed') : new IndexedDbDocumentStorage('fixed', openDb())
    for (let ts = 0; ts < 42; ts++) await storage.addVersion({ pageId: 'one', ts, title: 'note', content: {} })
    await storage.addVersion({ pageId: 'two', ts: 0, title: 'other', content: {} })
    const versions = await storage.listVersions('one')
    assert.equal(versions.length, 40)
    assert.equal(versions[0].ts, 41)
    assert.equal(versions.at(-1).ts, 2)
    await storage.deleteVersions('one')
    assert.deepEqual(await storage.listVersions('one'), [])
    assert.equal((await storage.listVersions('two')).length, 1)
  })
}

test('IndexedDB batch failures abort replacement instead of partially clearing the vault', async () => {
  const storage = new IndexedDbDocumentStorage('fixed', openDb())
  await storage.save(write(migrated, true))
  await assert.rejects(storage.save(write([migrated[0], { ...migrated[1], content: () => {} }], true)))
  assert.deepEqual(await storage.load(), migrated)
})

test('IndexedDB handle cannot silently switch databases or acknowledge a frozen save', async () => {
  const first = openDb(), second = openDb()
  let active = true, current = first
  const storage = new IndexedDbDocumentStorage('fixed', () => current(), () => active)
  await storage.save(write(migrated, true))
  active = false
  await assert.rejects(storage.save(write([], true)), /unavailable/)
  active = true
  assert.deepEqual(await storage.load(), migrated)
  current = second
  await assert.rejects(storage.load(), /vault changed/)
})

test('IndexedDB compare-and-save serializes competing adapters and detects same-timestamp changes', async () => {
  const open = openDb()
  const first = new IndexedDbDocumentStorage('fixed', open)
  const second = new IndexedDbDocumentStorage('fixed', open)
  const base = migrated[0]
  await first.save(write([base]))
  const one = { ...base, title: 'first' }, two = { ...base, title: 'second' }
  const results = await Promise.allSettled([first.compareAndSave(base, one), second.compareAndSave(base, two)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(results.find(result => result.status === 'rejected').reason.message, /revision conflict/)
  const [stored] = await first.load()
  assert.ok(stored.title === 'first' || stored.title === 'second')
  assert.equal(stored.updatedAt, base.updatedAt)
  await assert.rejects(first.compareAndSave(base, one), /revision conflict/)
  assert.deepEqual(await first.load(), [stored])
})

test('IndexedDB compare-and-save rejects a changed identity, unavailable store, or missing page', async () => {
  let active = true
  const storage = new IndexedDbDocumentStorage('fixed', openDb(), () => active)
  const base = migrated[0]
  await assert.rejects(storage.compareAndSave(base, { ...base, id: 'other' }), /identity changed/)
  await assert.rejects(storage.compareAndSave(base, base), /revision conflict/)
  await storage.save(write([base]))
  active = false
  await assert.rejects(storage.compareAndSave(base, base), /unavailable/)
  active = true
  assert.deepEqual(await storage.load(), [base])
})

test('IndexedDB services reject stale page updates and retain the unsaved edit', async () => {
  const open = openDb()
  const storageA = new IndexedDbDocumentStorage('fixed', open)
  const storageB = new IndexedDbDocumentStorage('fixed', open)
  await storageA.save(write(migrated, true))
  const a = new DocumentService({ storage: storageA, host: host() })
  const b = new DocumentService({ storage: storageB, host: host() })
  await Promise.all([a.init(), b.init()])
  const id = migrated[0].id
  a.update(id, { title: 'saved elsewhere' })
  await a.flushBeforeUpdate()
  b.update(id, { title: 'local draft' })
  await assert.rejects(b.flushBeforeUpdate(), /revision conflict/)
  assert.equal(b.get(id).title, 'local draft')
  assert.equal((await storageA.load()).find(page => page.id === id).title, 'saved elsewhere')
  await assert.rejects(b.flushBeforeUpdate(), /revision conflict/)
  assert.equal(b.get(id).title, 'local draft')
  await assert.rejects(b.flushForDatabase(), /revision conflict/)
})

test('IndexedDB guarded batches abort all writes on stale deletion or replacement', async () => {
  const storage = new IndexedDbDocumentStorage('fixed', openDb())
  const [a, b] = migrated
  await storage.save(write([a, b], true))
  const newer = { ...a, title: 'newer' }
  await storage.save(write([newer]))
  await assert.rejects(storage.save({ upserts: [{ ...b, title: 'changed' }], removed: [a.id], replaceAll: false,
    baseVersions: {}, expectedPages: { [a.id]: a, [b.id]: b } }), /revision conflict/)
  assert.deepEqual(await storage.load(), [newer, b].sort((x, y) => x.id.localeCompare(y.id)))
  await assert.rejects(storage.save({ ...write([b], true), expectedAll: [a, b] }), /revision conflict/)
  assert.deepEqual(await storage.load(), [newer, b].sort((x, y) => x.id.localeCompare(y.id)))
})

test('service does not treat a failed read as an empty vault and overwrite it with a seed', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  storage.load = async () => { throw Error('offline') }
  let saves = 0, seeds = 0
  storage.save = async () => { saves++ }
  const runtime = host()
  const service = new DocumentService({ storage, host: runtime }, () => { seeds++; return migrated })
  await assert.rejects(service.init(), /offline/)
  assert.equal(saves, 0)
  assert.equal(seeds, 0)
  assert.equal(runtime.errors[0].context, 'storage')
})

test('queued saves snapshot content and advance the baseline only to the persisted image', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  const original = storage.save.bind(storage)
  let release, started
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const writes = []
  storage.save = async batch => { writes.push(structuredClone(batch)); started(); if (writes.length === 1) await waiting; await original(batch) }
  const service = new DocumentService({ storage, host: host() })
  await service.init()
  const page = service.pagesOnly()[0]
  service.update(page.id, { title: 'first' })
  const first = service.flushed()
  await entered
  service.update(page.id, { title: 'second' })
  const second = service.flushed()
  release()
  await Promise.all([first, second])
  assert.equal(writes[0].upserts[0].title, 'first')
  assert.equal(writes[1].upserts[0].title, 'second')
  assert.equal(writes[1].baseVersions[page.id].updatedAt, writes[0].upserts[0].updatedAt)
  assert.equal((await storage.load()).find(p => p.id === page.id).title, 'second')
})

test('native adapter preserves base timestamps, permanently binds its vault and rejects switched results', async () => {
  let current = 'one', active = true, switchOnLoad = false
  const calls = []
  const storage = new NativeDocumentStorage('opaque-session', {
    active: () => active, currentVaultId: async () => current,
    load: async () => { if (switchOnLoad) current = 'two'; return migrated },
    save: async (...args) => { calls.push(args) }, stamp: async () => 'stamp',
    listVersions: async () => [], addVersion: async () => {}, deleteVersions: async () => {},
  })
  await storage.load()
  await storage.save({ ...write([migrated[0]]), baseVersions: { [migrated[0].id]: { updatedAt: 123, recordRevision: 4 } } })
  assert.equal(calls[0][0][0]._base, 123)
  active = false
  await assert.rejects(storage.save(write([], true)), /unavailable/)
  active = true
  switchOnLoad = true
  await assert.rejects(storage.load(), /vault changed/)
  await assert.rejects(storage.save(write([], true)), /vault changed/)
  assert.equal(calls.length, 1)
})

test('late watcher registration is released when stopped during startup', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  let release, registered, stopped = 0
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { registered = resolve })
  const runtime = host()
  runtime.watchExternal = async () => { registered(); await waiting; return () => { stopped++ } }
  const service = new DocumentService({ storage, host: runtime })
  await service.init()
  const watching = service.watch()
  await entered
  service.stopWatch()
  release()
  await watching
  assert.equal(stopped, 1)
})

const digest = async value => createHash('sha256').update(value).digest('hex')

test('coordinated commit rejects dirty drafts and typing while preparing, then publishes an exact revision', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  const service = new DocumentService({ storage, host: host() })
  await service.init()
  const before = service.dump()[0], next = { ...before, title: 'agent edit' }
  const revision = await documentRevision(before, digest)
  service.setEditorDirty(before.id, true)
  await assert.rejects(service.commitDocument(before, next, revision, digest), /unsaved changes/)
  service.setEditorDirty(before.id, false)
  const reserve = service.reserveCommit()
  service.setEditorDirty(before.id, true)
  await assert.rejects(reserve, /editor changed/)
  service.setEditorDirty(before.id, false)
  const receipt = await service.commitDocument(before, next, revision, digest)
  assert.equal(receipt.revision, await documentRevision(next, digest))
  assert.equal(service.getRaw(before.id).title, 'agent edit')
  assert.equal((await storage.load())[0].title, 'agent edit')
  await assert.rejects(service.commitDocument(before, next, revision, digest), /revision conflict/)
})

test('commit reservation blocks repository changes and releases after a storage failure', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  const runtime = host(), service = new DocumentService({ storage, host: runtime })
  await service.init()
  const before = service.dump()[0], next = { ...before, title: 'will fail' }
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  storage.save = async () => { entered(); await pending; throw Error('disk full') }
  const commit = service.commitDocument(before, next, await documentRevision(before, digest), digest)
  await started
  assert.equal(service.isWriteLocked(), true)
  assert.throws(() => service.update(before.id, { title: 'typing' }), /commit in progress/)
  assert.throws(() => service.restore([]), /commit in progress/)
  assert.throws(() => service.setEditorDirty(before.id, true), /commit in progress/)
  assert.equal(await service.refreshFromStore(), false)
  release()
  await assert.rejects(commit, /disk full/)
  assert.equal(service.isWriteLocked(), false)
  assert.deepEqual(service.dump()[0], before)
  assert.deepEqual((await storage.load())[0], before)
  assert.equal(runtime.events.filter(event => event.event === 'commit-state').length, 2)
})

test('external refresh retains an editor draft and later flush refuses the changed persisted baseline', async () => {
  const storage = new MemoryDocumentStorage('fixed', migrated)
  const service = new DocumentService({ storage, host: host() })
  await service.init()
  const before = service.dump()[0]
  service.setEditorDirty(before.id, true)
  await storage.save(write([{ ...before, title: 'sync change' }]))
  assert.equal(await service.refreshFromStore(), false)
  service.update(before.id, { title: 'human draft' })
  service.setEditorDirty(before.id, false)
  await assert.rejects(service.flushBeforeUpdate(), /revision conflict/)
  assert.equal(service.getRaw(before.id).title, 'human draft')
  assert.equal((await storage.load()).find(p => p.id === before.id).title, 'sync change')
})

test('native save sends exact preconditions and vault identity together to the command', async () => {
  const calls = []
  const storage = new NativeDocumentStorage('session', {
    active: () => true, currentVaultId: async () => 'bound-vault', load: async () => migrated,
    save: async (...args) => { calls.push(args) }, stamp: async () => '',
    listVersions: async () => [], addVersion: async () => {}, deleteVersions: async () => {},
  })
  const batch = { ...write([migrated[0]]), expectedPages: { [migrated[0].id]: migrated[0] } }
  await storage.save(batch)
  assert.deepEqual(calls[0][3], { expectedVaultId: 'bound-vault', expectedPages: batch.expectedPages, expectedAll: undefined })
})
