// Duplicating a whole database (handoff §13; R06, R07).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture, FIXTURE_CLOCK, FIXTURE_ZONE } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { runQuery, makeQuery } = await import('../../../spike/tiptap/src/database/query/engine.ts')

test('duplicate with rows: new ids everywhere, internal links remapped, external paired relation becomes one-way', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const res = await h.one('database.duplicate', { containerId: f.containerId, withRows: true })
  const mapping = res.mapping
  const newSource = mapping[f.sourceId]
  assert.ok(newSource && newSource !== f.sourceId)
  const rows = h.state.rows(newSource)
  assert.equal(rows.length, 4)
  assert.ok(rows.every((r) => !['T1', 'T2', 'T3', 'T4'].includes(r.page.id)))
  // values copied under the new property ids
  const newCost = mapping[f.cost]
  const q = runQuery(h.state, makeQuery(h.state, newSource, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, { sorts: [{ propertyId: newCost, direction: 'asc' }] }))
  assert.deepEqual(q.pageIds.map((id) => h.state.pages.get(id).title), ['T4', 'T1', 'T2', 'T3'])
  // the originals are untouched
  assert.equal(h.state.rows(f.sourceId).length, 4)
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 0)
  // Project relation pointed at Projects, which was NOT duplicated: the copy becomes one-way and the original reverse side is untouched
  const newRel = h.state.get('relation', mapping[f.projectRelation])
  assert.equal(newRel.mode, 'one_way')
  assert.equal(newRel.inversePropertyId, null)
  assert.equal(newRel.targetSourceId, f.projSrc)
  assert.equal(h.state.get('relation', f.projectRelation).mode, 'paired')
  // the edges to the (external) projects are not copied; the originals stay
  assert.equal(h.state.live('edge').filter((e) => e.definitionId === f.projectRelation).length, 3)
  assert.equal(h.state.live('edge').filter((e) => e.definitionId === newRel.id).length, 0)
  // views point at the new source
  assert.ok(h.state.viewsOf(mapping[f.containerId]).every((v) => v.sourceId === newSource))
  // the original reverse property still lists exactly the original tasks
  const rs = (await import('../../../spike/tiptap/src/database/resolver.ts')).Resolver
  const r = new rs(h.state, { principalId: 'U1', nowMs: Date.parse(FIXTURE_CLOCK), zone: FIXTURE_ZONE, weekStart: 6 })
  assert.deepEqual(r.value(h.state.row(f.P1), h.state.prop(f.tasksOnProject)).ids.sort(), ['T1', 'T2'])
})

test('schema-only duplicate has no rows and shares nothing mutable with the original', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  await h.one('property.create', { sourceId: f.sourceId, name: 'Key', kind: 'unique_id', config: { prefix: 'K', allocationMode: 'sequential' } })
  const res = await h.one('database.duplicate', { containerId: f.containerId, withRows: false, title: 'Tasks 2' })
  const ns = res.mapping[f.sourceId]
  assert.equal(h.state.rows(ns).length, 0)
  assert.equal(h.state.pages.get(res.hostPageId).title, 'Tasks 2')
  await h.one('property.configure', { propertyId: res.mapping[f.cost], name: 'Copy cost' })
  assert.equal(h.state.prop(f.cost).name, 'Cost')
  // new rows in the copy get their own numbering
  const a = await h.one('row.create', { sourceId: ns, title: 'new' })
  const keyCopy = h.state.props(ns).find((p) => p.kind === 'unique_id')
  assert.match(h.state.row(a.pageId).ext.allocatedIds[keyCopy.id], /:1$/)
})
