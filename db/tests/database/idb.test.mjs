// IndexedDB adapter: same fixture, same answers as the in-memory reference; atomic batches; stale-tab refusal; upgrade keeps pages.
import test from 'node:test'
import assert from 'node:assert/strict'

await import('../tools/node_modules/fake-indexeddb/auto/index.mjs')
const { createHarness, seedFixture, FIXTURE_CLOCK, FIXTURE_ZONE, MemoryPageHost, VAULT } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { IdbStorage, upgradeDatabaseStores, DB_SCHEMA_VERSION } = await import('../../../spike/tiptap/src/database/storage/idb.ts')
const { Coordinator } = await import('../../../spike/tiptap/src/database/commands/index.ts')
const { DbState, MemoryPages } = await import('../../../spike/tiptap/src/database/state.ts')
const { runQuery, makeQuery } = await import('../../../spike/tiptap/src/database/query/engine.ts')

let n = 0
function openDb(name, version = DB_SCHEMA_VERSION) {
  return () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: ['pageId', 'ts'] })
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv')
      if (version >= 2) upgradeDatabaseStores(d)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const dbName = () => `test-${++n}-${Math.random()}`
const idbHarness = (name) => {
  const open = openDb(name)
  let storage
  const h = createHarness({ storage: () => (storage = new IdbStorage(open)) })
  return { h, storage, open }
}
const pagesFromIdb = async (open) => {
  const d = await open()
  return new Promise((res, rej) => { const r = d.transaction('pages').objectStore('pages').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
}
async function reopen(open, device = 'D1') {
  const pages = new MemoryPages(await pagesFromIdb(open))
  const storage = new IdbStorage(open)
  const state = new DbState(VAULT, pages)
  const coord = new Coordinator({ state, storage, pageHost: new MemoryPageHost(pages), deviceId: device, now: () => Date.parse(FIXTURE_CLOCK) })
  await coord.open()
  return { state, coord, pages, storage }
}

test('Q01 adapter parity: memory and IndexedDB give identical query results for the shared fixture', async () => {
  const mem = createHarness()
  const fm = await seedFixture(mem)
  const { h } = idbHarness(dbName())
  const fi = await seedFixture(h)
  const run = (hh, f, over) => runQuery(hh.state, makeQuery(hh.state, f.sourceId, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, over))
  const shape = (r) => ({ ids: r.pageIds, total: r.total, groups: r.groups.map((g) => [g.label, g.pageIds]) })
  for (const spec of [
    (f) => ({ sorts: [{ propertyId: f.cost, direction: 'asc' }] }),
    (f) => ({ sorts: [{ propertyId: f.cost, direction: 'desc' }] }),
    (f) => ({ filter: { kind: 'predicate', propertyId: f.done, op: 'equals', operand: false } }),
    (f) => ({ filter: { kind: 'predicate', propertyId: f.due, op: 'relative', operand: { kind: 'today' } } }),
    (f) => ({ group: { propertyId: f.tags } }),
    (f) => ({ search: 'blue' }),
  ]) assert.deepEqual(shape(run(h, fi, spec(fi))), shape(run(mem, fm, spec(fm))))
})

test('IDB: a fresh process reads back every record and page; undo stack and operation results persist', async () => {
  const { h, open } = idbHarness(dbName())
  const f = await seedFixture(h)
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 5 } } })
  await new Promise((r) => setTimeout(r, 30))
  const r = await reopen(open)
  assert.equal(r.state.rows(f.sourceId).length, 4)
  assert.equal(r.state.row('T1').ext.cells[f.cost].value.value, 5)
  assert.equal(r.state.live('edge').length, 3)
  assert.ok(r.coord.undoStack.length > 0)
  assert.ok(await r.storage.getOperation('seed-db'))
  assert.ok((await r.storage.history('page', 'T1')).length >= 1)
})

test('IDB: one batch is one transaction — a failing record write leaves no page behind', async () => {
  const { h, open, storage } = idbHarness(dbName())
  await seedFixture(h)
  const bad = {
    operationId: 'bad', vaultId: VAULT,
    records: [{ kind: 'view', id: 'v-bad', baseRevision: 0, after: { id: 'v-bad', fn() {} } }],
    pages: [{ id: 'T1', baseRevision: h.state.row('T1').page.recordMeta.revision, after: { ...h.state.row('T1').page, title: 'should not persist' } }],
    history: [], commit: { operationId: 'bad', generation: 1, changed: [], warnings: [] }, undo: null,
  }
  await assert.rejects(storage.commit(bad))
  const r = await reopen(open)
  assert.equal(r.state.row('T1').page.title, 'T1')
  assert.equal(r.state.get('view', 'v-bad'), undefined)
})

test('IDB: a stale tab is refused (REVISION_CONFLICT) instead of overwriting, then reloads and succeeds', async () => {
  const name = dbName()
  const a = idbHarness(name)
  const f = await seedFixture(a.h)
  const b = await reopen(a.open, 'D2')
  await a.h.one('view.patch', { viewId: f.viewId, name: 'from A' })
  const cmd = (op, name2) => b.coord.execute({ operationId: op, vaultId: VAULT, actorId: 'U1', deviceId: 'D2', expected: [], origin: 'user', commands: [{ type: 'view.patch', payload: { viewId: f.viewId, name: name2 } }] })
  await assert.rejects(cmd('b1', 'from B'), (e) => e.code === 'REVISION_CONFLICT')
  await b.coord.reloadExternal()
  assert.equal(b.state.get('view', f.viewId).name, 'from A')
  await cmd('b2', 'from B')
  assert.equal(b.state.get('view', f.viewId).name, 'from B')
})

test('IDB upgrade v1 -> v2 keeps existing pages and adds the database stores', async () => {
  const name = dbName()
  const v1 = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { const d = req.result; d.createObjectStore('pages', { keyPath: 'id' }); d.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }); d.createObjectStore('kv') }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await new Promise((res, rej) => { const tx = v1.transaction('pages', 'readwrite'); tx.objectStore('pages').put({ id: 'old', title: 'legacy', parentId: null, content: {}, updatedAt: 1, deletedAt: null, favorite: false, sort: 0 }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  v1.close()
  const open = openDb(name)
  const d = await open()
  assert.deepEqual([...d.objectStoreNames].sort(), ['db_history', 'db_meta', 'db_ops', 'db_records', 'db_runtime', 'kv', 'pages', 'versions'])
  assert.equal((await pagesFromIdb(open)).length, 1)
  d.close()
})

test('IDB: unknown newer record formats are quarantined and left untouched', async () => {
  const { h, open } = idbHarness(dbName())
  await seedFixture(h)
  const d = await open()
  await new Promise((res, rej) => { const tx = d.transaction('db_records', 'readwrite'); tx.objectStore('db_records').put({ format: 9, id: 'alien', revision: 1 }, 'view/alien'); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  const loaded = await new IdbStorage(open).loadAll()
  assert.deepEqual(loaded.quarantined.map((q) => q.id), ['alien'])
  assert.equal((loaded.records.view ?? []).some((v) => v.id === 'alien'), false)
})
