// Persistence, journal recovery, idempotency, undo, history (handoff §6, §12; F30-F34).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture, MemoryPageHost, VAULT } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { Coordinator } = await import('../../../spike/tiptap/src/database/commands/index.ts')
const { DbState } = await import('../../../spike/tiptap/src/database/state.ts')

test('a transition drains accepted commands but rejects new commands until resumed', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const original = h.storage.commit.bind(h.storage)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  h.storage.commit = async batch => { entered(); await blocked; return original(batch) }
  const accepted = h.one('view.patch', { viewId: f.viewId, name: 'accepted before transition' })
  await started
  const resume = h.coord.pauseWrites()
  await assert.rejects(h.one('view.patch', { viewId: f.viewId, name: 'too late' }), e => e.code === 'READ_ONLY')
  release()
  await accepted
  await h.coord.flushed()
  assert.equal(h.state.get('view', f.viewId).name, 'accepted before transition')
  resume()
  await h.one('view.patch', { viewId: f.viewId, name: 'resumed' })
  assert.equal(h.state.get('view', f.viewId).name, 'resumed')
})

test('a failed durable database write blocks an update drain until a successful retry', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const original = h.storage.commit.bind(h.storage)
  h.storage.commit = async () => { throw new Error('disk full') }
  await assert.rejects(h.one('view.patch', { viewId: f.viewId, name: 'pending' }), /disk full/)
  await assert.rejects(h.coord.flushed(), /disk full/)
  h.storage.commit = original
  await h.one('view.patch', { viewId: f.viewId, name: 'pending' })
  await h.coord.flushed()
  assert.equal(h.state.get('view', f.viewId).name, 'pending')
})

test('undo persistence finishes or blocks the transition without undoing an acknowledged document', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const original = h.storage.saveUndo.bind(h.storage)
  h.storage.saveUndo = async () => { throw new Error('undo disk unavailable') }
  await h.one('view.patch', { viewId: f.viewId, name: 'document saved' })
  assert.equal(h.state.get('view', f.viewId).name, 'document saved')
  await assert.rejects(h.coord.flushed(), /undo disk unavailable/)
  h.storage.saveUndo = original
  await h.coord.flushed()
  assert.ok((await h.storage.loadUndo()).length)
})

/** "Restart the process": fresh state + coordinator over the same durable storage and pages. */
async function restart(h) {
  const state = new DbState(VAULT, h.pages)
  const coord = new Coordinator({ state, storage: h.storage, pageHost: new MemoryPageHost(h.pages), deviceId: 'D1', now: () => Date.parse('2026-10-25T08:00:00Z'), ids: h.ids })
  const quarantined = await coord.open()
  return { state, coord, quarantined }
}

test('reload: everything written is read back by a fresh process', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const r = await restart(h)
  assert.equal(r.state.rows(f.sourceId).length, 4)
  assert.equal(r.state.props(f.sourceId).length, h.state.props(f.sourceId).length)
  assert.equal(r.state.row('T2').ext.cells[f.cost].value.value, 10)
  assert.equal(r.state.live('edge').length, 3)
  assert.equal(r.quarantined.length, 0)
})

test('F33 crash after the journal commit but before all files are written: replay applies the full batch once', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  h.storage.crashAt = 'between_writes'
  await assert.rejects(h.run([
    { type: 'row.patch', payload: { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 11 } } } },
    { type: 'row.patch', payload: { pageId: 'T2', cellChanges: { [f.cost]: { kind: 'number', value: 22 } } } },
    { type: 'view.patch', payload: { viewId: f.viewId, name: 'Renamed' } },
  ], { operationId: 'crashy' }))
  h.storage.crashAt = null
  const r = await restart(h)
  assert.equal(r.state.get('view', f.viewId).name, 'Renamed')
  assert.equal(r.state.row('T1').ext.cells[f.cost].value.value, 11)
  assert.equal(r.state.row('T2').ext.cells[f.cost].value.value, 22)
  const revs = r.state.row('T1').page.recordMeta.revision
  const again = await restart(h) // recovering twice must not apply twice
  assert.equal(again.state.row('T1').page.recordMeta.revision, revs)
})

test('F34 crash before the journal commit leaves no visible mutation', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const before = JSON.stringify(h.state.row('T1').ext.cells)
  h.storage.crashAt = 'before_journal_commit'
  await assert.rejects(h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 123 } } }))
  h.storage.crashAt = null
  const r = await restart(h)
  assert.equal(JSON.stringify(r.state.row('T1').ext.cells), before)
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 0) // the live state did not move either
})

test('crash before the index update still recovers (index is derived)', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  h.storage.crashAt = 'before_index'
  await assert.rejects(h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 5 } } }))
  h.storage.crashAt = null
  const r = await restart(h)
  assert.equal(r.state.row('T1').ext.cells[f.cost].value.value, 5)
})

test('a journal that matches neither side fails closed with RECOVERY_REQUIRED', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  h.storage.crashAt = 'after_journal_commit'
  await assert.rejects(h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 5 } } }))
  h.storage.crashAt = null
  // someone else changed the same file in the meantime (revision no longer matches old or new)
  const p = h.pages.get('T1')
  p.recordMeta = { ...p.recordMeta, revision: p.recordMeta.revision + 7 }
  await assert.rejects(restart(h), (e) => e.code === 'RECOVERY_REQUIRED')
})

test('a failed save keeps state untouched and the retry with the same operation id succeeds once', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const err = new Error('disk full')
  h.storage.failWith = err
  await assert.rejects(h.run([{ type: 'row.patch', payload: { pageId: 'T3', cellChanges: { [f.cost]: { kind: 'number', value: 42 } } } }], { operationId: 'retry-me' }), (e) => e.code === 'IO')
  assert.equal(h.state.row('T3').ext.cells[f.cost], undefined)
  h.storage.failWith = null
  const a = await h.run([{ type: 'row.patch', payload: { pageId: 'T3', cellChanges: { [f.cost]: { kind: 'number', value: 42 } } } }], { operationId: 'retry-me' })
  const b = await h.run([{ type: 'row.patch', payload: { pageId: 'T3', cellChanges: { [f.cost]: { kind: 'number', value: 42 } } } }], { operationId: 'retry-me' })
  assert.equal(a.operationId, b.operationId)
  assert.equal(h.state.row('T3').page.recordMeta.revision, 2) // legacy revision 0 -> created (1) -> patched (2)
})

test('F30 the derived index is disposable: rebuilding from canonical files gives identical results', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const { runQuery, makeQuery } = await import('../../../spike/tiptap/src/database/query/engine.ts')
  const run = (st) => runQuery(st, makeQuery(st, f.sourceId, 'U1', '2026-10-25T08:00:00Z', 'Asia/Tehran', { sorts: [{ propertyId: f.cost, direction: 'asc' }], group: { propertyId: f.tags }, projection: [f.cost, f.tags] }))
  const a = run(h.state)
  h.storage.indexGeneration = 0
  const r = await restart(h)
  const b = run(r.state)
  const strip = (x) => JSON.stringify({ ...x, generation: 0, nextCursor: null })
  assert.equal(strip(b), strip(a))
})

test('stale expected revision is a REVISION_CONFLICT; disjoint cell patches rebase', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const rev = h.state.row('T1').page.recordMeta.revision
  // device B edits Notes after we read revision `rev`
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.notes]: { kind: 'text', runs: [{ text: 'b' }] } } })
  // our edit of Cost is disjoint from Notes: allowed to rebase
  await h.run([{ type: 'row.patch', payload: { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 1 } } } }], { expected: [{ recordKind: 'page', id: 'T1', revision: rev }] })
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 1)
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.runs[0].text, 'b')
  // but the same cell edited since is a real conflict with the current revision attached
  const rev2 = h.state.row('T1').page.recordMeta.revision
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 2 } } })
  await assert.rejects(
    h.run([{ type: 'row.patch', payload: { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 3 } } } }], { expected: [{ recordKind: 'page', id: 'T1', revision: rev2 }] }),
    (e) => e.code === 'REVISION_CONFLICT' && e.detail.current === rev2 + 1,
  )
  // schema records are whole-record guarded
  const vrev = h.state.get('view', f.viewId).revision
  await h.one('view.patch', { viewId: f.viewId, name: 'x' })
  await assert.rejects(h.run([{ type: 'view.patch', payload: { viewId: f.viewId, name: 'y' } }], { expected: [{ recordKind: 'view', id: f.viewId, revision: vrev }] }), (e) => e.code === 'REVISION_CONFLICT')
})

test('no-op edits create no revision; first committed edit upgrades a legacy page once', async () => {
  const h = createHarness()
  await seedFixture(h)
  h.pages.put({ id: 'legacy', parentId: null, title: 'old', favorite: false, sort: 0, content: { type: 'doc', content: [] }, updatedAt: 111, deletedAt: null })
  assert.equal(h.pages.get('legacy').recordMeta, undefined)
  await h.one('page.patch_body', { pageId: 'legacy', content: { type: 'doc', content: [{ type: 'paragraph' }] } })
  const m = h.pages.get('legacy').recordMeta
  assert.equal(m.revision, 1)
  assert.equal(m.createdAt, 111) // reliable existing timestamp, marked inferred
  assert.equal(m.inferred, true)
  const rev = h.pages.get('T1').recordMeta.revision
  await h.one('row.patch', { pageId: 'T1', title: 'T1' }) // same title: nothing changes
  assert.equal(h.pages.get('T1').recordMeta.revision, rev)
})

test('undo restores only fields this batch wrote; conflicts are previewed; partial undo is explicit', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  await h.one('row.patch', { pageId: 'T2', title: 'changed', cellChanges: { [f.cost]: { kind: 'number', value: 77 } } })
  let u = await h.coord.undo('U1')
  assert.equal(u.ok, true)
  assert.equal(h.state.row('T2').ext.cells[f.cost].value.value, 10)
  assert.equal(h.state.row('T2').page.title, 'T2')
  // undo of a created row trashes it
  const made = await h.one('row.create', { sourceId: f.sourceId, title: 'temp' })
  await h.coord.undo('U1')
  assert.notEqual(h.state.pages.get(made.pageId).deletedAt, null)
  // a later edit of one touched field conflicts
  await h.one('row.patch', { pageId: 'T1', title: 'one', cellChanges: { [f.cost]: { kind: 'number', value: 5 } } })
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 6 } } })
  await h.coord.undo('U1') // undoes the second patch (no conflict)
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 5)
  // edit the cost again behind the first group's back, then undo it: title restores only with partial
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 8 } } })
  h.coord.undoStack.splice(h.coord.undoStack.length - 1, 1) // drop that group so the one-before is on top
  const prev = h.coord.undoPreview()
  assert.deepEqual(prev.conflicts.map((c) => c.path), [`cell:${f.cost}`])
  const refused = await h.coord.undo('U1')
  assert.equal(refused.ok, false)
  const partial = await h.coord.undo('U1', { partial: true })
  assert.equal(partial.ok, true)
  assert.equal(h.state.row('T1').page.title, 'T1')
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 8) // the conflicting cell is left alone
})

test('undo stack survives restart (>=100 groups retained)', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  for (let i = 0; i < 110; i++) await h.one('row.patch', { pageId: 'T3', cellChanges: { [f.cost]: { kind: 'number', value: i } } })
  await new Promise((r) => setTimeout(r, 10))
  const r = await restart(h)
  assert.ok(r.coord.undoStack.length >= 100)
})

test('record history keeps full pre-images, including tombstoned definitions', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  await h.one('property.configure', { propertyId: f.cost, name: 'Budget' })
  await h.one('property.delete', { propertyId: f.cost })
  const hist = await h.storage.history('property', f.cost)
  assert.equal(hist.length, 2)
  assert.equal(hist[1].body.name, 'Cost')
  assert.equal(hist[0].body.name, 'Budget')
  // restore keeps the old id and the stored values
  await h.one('property.restore', { propertyId: f.cost })
  assert.equal(h.state.prop(f.cost).name, 'Budget')
  assert.equal(h.state.row('T2').ext.cells[f.cost].value.value, 10)
})

test('unknown newer record formats are quarantined, not rewritten', async () => {
  const h = createHarness()
  await seedFixture(h)
  h.storage.files.set('view/alien', { format: 2, id: 'alien', revision: 9, deletedAt: null })
  const r = await restart(h)
  assert.deepEqual(r.quarantined.map((q) => q.id), ['alien'])
  assert.equal(r.state.get('view', 'alien'), undefined)
  assert.equal(h.storage.files.get('view/alien').format, 2)
})
