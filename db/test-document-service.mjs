import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { identifyBlocks } from '../spike/tiptap/src/documents/blockIdentity.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'
import { NativeDocumentStorage } from '../spike/tiptap/src/platform/documents/native.ts'
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
