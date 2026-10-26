// Query semantics on the deterministic fixture (handoff §28, F01-F11, F19-F24, F27-F29, F31-F32, F36-F37).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture, FIXTURE_CLOCK, FIXTURE_ZONE } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { runQuery, makeQuery } = await import('../../../spike/tiptap/src/database/query/engine.ts')
const { Resolver } = await import('../../../spike/tiptap/src/database/resolver.ts')

async function setup() {
  const h = createHarness()
  const f = await seedFixture(h)
  const q = (over = {}, principal = 'U1') => runQuery(h.state, makeQuery(h.state, f.sourceId, principal, FIXTURE_CLOCK, FIXTURE_ZONE, over))
  const ids = (res) => res.pageIds
  const pred = (propertyId, op, operand) => ({ kind: 'predicate', propertyId, op, operand })
  return { h, f, q, ids, pred }
}

test('F01-F04 filters: empty, false/0 are not empty, whitespace is not empty, compound', async () => {
  const { f, q, ids, pred } = await setup()
  assert.deepEqual(ids(q({ filter: pred(f.cost, 'is_empty') })), ['T3'])
  assert.deepEqual(ids(q({ filter: pred(f.done, 'equals', false) })), ['T1', 'T3'])
  assert.deepEqual(ids(q({ filter: pred(f.notes, 'is_empty') })), ['T1']) // T2 is three spaces
  assert.deepEqual(
    ids(q({ filter: { kind: 'and', children: [{ kind: 'or', children: [pred(f.status, 'equals', f.so('todo')), pred(f.status, 'equals', f.so('doing'))] }, pred(f.cost, 'gte', 0)] } })),
    ['T1', 'T2'],
  )
  assert.deepEqual(ids(q({ filter: pred(f.cost, 'equals', 0) })), ['T1']) // zero is a value
})

test('F05-F06 sort: numbers numeric, empty last in both directions', async () => {
  const { f, q, ids } = await setup()
  assert.deepEqual(ids(q({ sorts: [{ propertyId: f.cost, direction: 'asc' }] })), ['T4', 'T1', 'T2', 'T3'])
  assert.deepEqual(ids(q({ sorts: [{ propertyId: f.cost, direction: 'desc' }] })), ['T2', 'T1', 'T4', 'T3'])
})

test('F07 relative date today in the fixture zone', async () => {
  const { f, q, ids, pred } = await setup()
  assert.deepEqual(ids(q({ filter: pred(f.due, 'relative', { kind: 'today' }) })), ['T1'])
  assert.deepEqual(ids(q({ filter: pred(f.due, 'relative', { kind: 'next_week' }) })), ['T2']) // rolling: 26th..1st
  assert.deepEqual(ids(q({ filter: pred(f.due, 'before', '2026-10-25') })), ['T4'])
  assert.deepEqual(ids(q({ filter: pred(f.due, 'on_or_after', '2026-10-26') })), ['T2'])
  assert.deepEqual(ids(q({ filter: pred(f.due, 'between', { start: '2026-10-27', end: '2026-10-30' }) })), ['T2']) // a range overlaps
  assert.deepEqual(ids(q({ filter: pred(f.due, 'equals', '2026-10-27') })), ['T2'])
})

test('F08 grouping: multi-value rows appear in several groups, totals count distinct pages', async () => {
  const { f, q } = await setup()
  const r = q({ group: { propertyId: f.tags } })
  const g = Object.fromEntries(r.groups.map((x) => [x.label || 'unassigned', x.pageIds]))
  assert.deepEqual(g, { red: ['T1'], blue: ['T1', 'T2'], green: ['T4'], unassigned: ['T3'] })
  assert.equal(r.total, 4)
  assert.deepEqual(r.groups.map((x) => x.label), ['red', 'blue', 'green', '']) // option order, unassigned last
  const byStatus = q({ group: { propertyId: f.status, mode: 'status_group' } })
  assert.deepEqual(byStatus.groups.map((x) => x.pageIds), [['T1', 'T4'], ['T2'], ['T3']])
})

test('F09 totals run over the whole matching set', async () => {
  const { f, q } = await setup()
  const r = q({ totals: { [f.cost]: 'sum' }, limit: 1 })
  assert.equal(r.pageIds.length, 1)
  assert.equal(r.total, 4)
  assert.equal(r.totals[f.cost].value.n, 5)
  assert.equal(q({ totals: { [f.cost]: 'average' } }).totals[f.cost].value.n, 5 / 3)
  assert.equal(q({ totals: { [f.cost]: 'median' } }).totals[f.cost].value.n, 0)
})

test('F10-F11 rollups on related projects', async () => {
  const { h, f } = await setup()
  const sum = await h.one('property.create', { sourceId: f.projSrc, name: 'CostSum', kind: 'rollup', config: { relationPropertyId: f.tasksOnProject, targetPropertyId: f.cost, aggregation: 'sum' } })
  const cnt = await h.one('property.create', { sourceId: f.projSrc, name: 'N', kind: 'rollup', config: { relationPropertyId: f.tasksOnProject, targetPropertyId: f.cost, aggregation: 'count_all' } })
  const avg = await h.one('property.create', { sourceId: f.projSrc, name: 'Avg', kind: 'rollup', config: { relationPropertyId: f.tasksOnProject, targetPropertyId: f.cost, aggregation: 'average' } })
  const rs = new Resolver(h.state, { principalId: 'U1', nowMs: Date.parse(FIXTURE_CLOCK), zone: FIXTURE_ZONE, weekStart: 6 })
  const val = (page, id) => rs.value(h.state.row(page), h.state.prop(id))
  assert.equal(val('P1', sum.propertyId).n, 10)
  assert.equal(val('P1', cnt.propertyId).n, 2)
  assert.equal(val('P2', sum.propertyId).n, 0)
  assert.equal(val('P2', avg.propertyId).c, 'empty') // average of nothing is null, not 0
  assert.equal(val('P2', cnt.propertyId).n, 1)
})

test('F19 multi-select drag semantics are plain cell patches; no new row appears', async () => {
  const { h, f, q } = await setup()
  const before = q().total
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.tags]: { kind: 'multi_select', optionIds: [f.to('blue'), f.to('green')] } } })
  assert.equal(q().total, before)
  assert.deepEqual(h.state.row('T1').ext.cells[f.tags].value.optionIds, [f.to('blue'), f.to('green')])
})

test('F21-F24 creation precedence: explicit > location > template > inference > defaults', async () => {
  const { h, f } = await setup()
  const so = f.so
  const view = (filter) => h.one('view.create', { containerId: f.containerId, sourceId: f.sourceId, type: 'table', name: 'v' }).then(async (r) => { await h.one('view.patch', { viewId: r.viewId, filter }); return r.viewId })
  const tpl = await h.one('record.put', { kind: 'template', body: { sourceId: f.sourceId, name: 'T', icon: null, cover: null, defaults: { [f.status]: { kind: 'status', optionId: so('todo') } }, body: null, nested: [], repeat: null, scheduleVersion: 1 } })
  const doingView = await view({ kind: 'predicate', propertyId: f.status, op: 'equals', operand: so('doing') })
  const statusOf = (id) => h.state.row(id).ext.cells[f.status]?.value.optionId
  // F21: template status=todo beats the view's inferred doing
  const a = await h.one('row.create', { sourceId: f.sourceId, viewId: doingView, templateId: tpl.id, title: 'a' })
  assert.equal(statusOf(a.pageId), so('todo'))
  // without a template the view's equality is inferred
  const inferred = await h.one('row.create', { sourceId: f.sourceId, viewId: doingView, title: 'inferred' })
  assert.equal(statusOf(inferred.pageId), so('doing'))
  // F22: explicit creation location (board column) beats the template
  const b = await h.one('row.create', { sourceId: f.sourceId, viewId: doingView, templateId: tpl.id, context: [{ propertyId: f.status, cell: { kind: 'status', optionId: so('doing') } }], title: 'b' })
  assert.equal(statusOf(b.pageId), so('doing'))
  // F23: explicit values beat everything
  const c = await h.one('row.create', { sourceId: f.sourceId, viewId: doingView, templateId: tpl.id, explicitValues: { [f.status]: { kind: 'status', optionId: so('done') } }, title: 'c' })
  assert.equal(statusOf(c.pageId), so('done'))
  // F24: OR(todo, doing) infers nothing; the type default (first option) applies
  const orView = await view({ kind: 'or', children: [{ kind: 'predicate', propertyId: f.status, op: 'equals', operand: so('todo') }, { kind: 'predicate', propertyId: f.status, op: 'equals', operand: so('doing') }] })
  const d = await h.one('row.create', { sourceId: f.sourceId, viewId: orView, title: 'd' })
  assert.equal(statusOf(d.pageId) ?? so('todo'), so('todo'))
  assert.equal(h.state.row(d.pageId).ext.cells[f.status], undefined) // nothing stored: default is implicit
})

test('F27-F28 paired relation: one canonical edge, reverse derived, trash/restore without duplicates', async () => {
  const { h, f } = await setup()
  const rs = () => new Resolver(h.state, { principalId: 'U1', nowMs: Date.parse(FIXTURE_CLOCK), zone: FIXTURE_ZONE, weekStart: 6 })
  const edges = () => h.state.all('edge').filter((e) => e.deletedAt === null).length
  const n0 = edges()
  await h.one('relation.add', { definitionId: f.projectRelation, fromPageId: 'T4', toPageId: f.P1 })
  assert.equal(edges(), n0 + 1)
  const rev = rs().value(h.state.row(f.P1), h.state.prop(f.tasksOnProject))
  assert.deepEqual(rev.ids.sort(), ['T1', 'T2', 'T4'])
  // single-valued Project: moving T4 needs an explicit replace
  await assert.rejects(h.one('relation.add', { definitionId: f.projectRelation, fromPageId: 'T4', toPageId: f.P2 }), (e) => e.code === 'RELATION_LIMIT')
  await h.one('relation.add', { definitionId: f.projectRelation, fromPageId: 'T4', toPageId: f.P2, replace: true })
  assert.deepEqual(rs().value(h.state.row(f.P1), h.state.prop(f.tasksOnProject)).ids.sort(), ['T1', 'T2'])
  // trash P1: the link shows a deleted marker, restore revives the same edge
  await h.one('row.trash', { pageIds: [f.P1] })
  const t = rs().relationTargets(h.state.row('T1'), h.state.prop(f.project))
  assert.equal(t[0].state, 'trashed')
  const before = edges()
  await h.one('row.restore', { pageIds: [f.P1] })
  assert.equal(edges(), before)
  assert.equal(rs().relationTargets(h.state.row('T1'), h.state.prop(f.project))[0].state, 'live')
})

test('F29 two views over one source share values; view filters stay independent', async () => {
  const { h, f, q } = await setup()
  const v2 = await h.one('view.create', { containerId: f.containerId, sourceId: f.sourceId, type: 'table', name: 'Second' })
  await h.one('view.patch', { viewId: v2.viewId, filter: { kind: 'predicate', propertyId: f.done, op: 'equals', operand: true } })
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 99 } } })
  const viewFilter = h.state.get('view', v2.viewId).filter
  assert.deepEqual(q({ filter: viewFilter }).pageIds, ['T2', 'T4'])
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 99)
  assert.equal(h.state.get('view', f.viewId).filter, null)
})

test('F31 retried operation id creates one row and one allocated id', async () => {
  const { h, f } = await setup()
  await h.one('property.create', { sourceId: f.sourceId, name: 'Key', kind: 'unique_id', config: { prefix: 'TSK', allocationMode: 'sequential' } })
  const n0 = h.state.rows(f.sourceId).length
  const cmd = { type: 'row.create', payload: { sourceId: f.sourceId, title: 'x' } }
  const a = await h.run([cmd], { operationId: 'same-op' })
  const b = await h.run([cmd], { operationId: 'same-op' })
  assert.deepEqual(a, b)
  assert.equal(h.state.rows(f.sourceId).length, n0 + 1)
  const alloc = h.state.all('allocator')[0]
  assert.equal(alloc.next, 6) // 4 backfilled + this one = tokens 1..5, next is 6 exactly once
})

test('F32 an invalid cell in a bulk patch changes nothing', async () => {
  const { h, f } = await setup()
  const snap = JSON.stringify(h.state.row('T1').ext.cells)
  await assert.rejects(
    h.one('row.patch_bulk', { patches: [{ pageId: 'T1', cellChanges: { [f.cost]: { kind: 'number', value: 7 } } }, { pageId: 'T2', cellChanges: { [f.cost]: { kind: 'number', value: Infinity } } }] }),
    (e) => e.code === 'INVALID_VALUE',
  )
  assert.equal(JSON.stringify(h.state.row('T1').ext.cells), snap)
  assert.equal(h.state.row('T2').ext.cells[f.cost].value.value, 10)
})

test('F36 title/body writes keep every database value (page.patch_body preserves the extension)', async () => {
  const { h } = await setup()
  const before = JSON.stringify(h.state.row('T2').ext.cells)
  await h.one('page.patch_body', { pageId: 'T2', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] } })
  await h.one('row.patch', { pageId: 'T2', title: 'renamed' })
  assert.equal(JSON.stringify(h.state.row('T2').ext.cells), before)
  assert.equal(h.state.row('T2').page.title, 'renamed')
})

test('F37 a principal without access to Cost cannot sort, filter or group by it, and sees no order leak', async () => {
  const { h, f, q } = await setup()
  const guest = await h.one('record.put', { kind: 'principal', body: { type: 'user', displayName: 'G', email: null, memberIds: [], isLocalOwner: false, externalId: null }, id: 'U2' })
  void guest
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U2', containerId: null, sourceId: f.sourceId, pageId: null, right: 'edit_content', propertyId: null, propertyRights: null, viaPropertyId: null } })
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U1', containerId: null, sourceId: f.sourceId, pageId: null, right: 'full', propertyId: f.cost, propertyRights: { seeDefinition: true, readValues: true, editValues: true, editDefinition: true }, viaPropertyId: null } })
  assert.equal(q({}, 'U2').total, 4) // rows visible
  assert.throws(() => q({ sorts: [{ propertyId: f.cost, direction: 'asc' }] }, 'U2'), (e) => e.code === 'ACCESS_DENIED')
  assert.throws(() => q({ filter: { kind: 'predicate', propertyId: f.cost, op: 'gt', operand: 0 } }, 'U2'), (e) => e.code === 'ACCESS_DENIED')
  assert.throws(() => q({ group: { propertyId: f.cost } }, 'U2'), (e) => e.code === 'ACCESS_DENIED')
  const r = q({ projection: [f.cost, f.notes] }, 'U2')
  assert.equal(r.rows[0].values[f.cost].c, 'blocked') // restricted marker, not a fake empty value
  assert.equal(r.rows[0].values[f.cost].state, 'restricted')
  assert.notEqual(r.rows[1].values[f.notes].c, 'blocked')
  // owner still reads it
  assert.equal(q({ projection: [f.cost] }).rows[0].values[f.cost].n, 0)
})

test('query validation: unknown operator, wrong operand, button, stale cursor, limits', async () => {
  const { h, f, q } = await setup()
  const bad = (filter) => assert.throws(() => q({ filter }), (e) => e.code === 'INVALID_FILTER')
  bad({ kind: 'predicate', propertyId: f.cost, op: 'contains', operand: 'x' })
  bad({ kind: 'predicate', propertyId: f.cost, op: 'gt', operand: 'x' })
  bad({ kind: 'predicate', propertyId: 'nope', op: 'equals', operand: 1 })
  bad({ kind: 'predicate', propertyId: f.status, op: 'equals', operand: 'not-an-option' })
  const many = { kind: 'and', children: Array.from({ length: 17 }, () => ({ kind: 'and', children: [] })) }
  bad(many)
  // pagination: cursor stays valid until data changes
  const p1 = q({ limit: 2 })
  assert.equal(p1.pageIds.length, 2)
  const p2 = q({ limit: 2, cursor: p1.nextCursor })
  assert.deepEqual([...p1.pageIds, ...p2.pageIds].slice(0, 4), ['T1', 'T2', 'T3', 'T4'])
  assert.equal(p2.nextCursor, null)
  await h.one('row.patch', { pageId: 'T1', title: 'changed' })
  assert.throws(() => q({ limit: 2, cursor: p1.nextCursor }), (e) => e.code === 'STALE_CURSOR')
})

test('search covers title and properties, never the body; words are ANDed; Persian normalization', async () => {
  const { h, f, q, ids } = await setup()
  await h.one('page.patch_body', { pageId: 'T1', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secretword' }] }] } })
  assert.deepEqual(ids(q({ search: 'secretword' })), []) // body is not searched
  assert.deepEqual(ids(q({ search: 'ALPHA' })), ['T3']) // notes, case folded
  assert.deepEqual(ids(q({ search: 'todo done' })), []) // ANDed: no row has both
  assert.deepEqual(ids(q({ search: 'blue red' })), ['T1'])
  await h.one('row.patch', { pageId: 'T4', title: 'كتاب' }) // Arabic kaf / yeh
  assert.deepEqual(ids(q({ search: 'کتاب' })), ['T4'])
  assert.deepEqual(ids(q({ search: 'P1' })), ['T1', 'T2']) // relation target title
  void f
})

test('formula property: typed result, rename keeps the binding, filterable by result type', async () => {
  const { h, f, q, ids } = await setup()
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'Double', kind: 'formula', config: { source: 'prop("Cost") * 2' } })
  const rs = new Resolver(h.state, { principalId: 'U1', nowMs: Date.parse(FIXTURE_CLOCK), zone: FIXTURE_ZONE, weekStart: 6 })
  assert.equal(rs.value(h.state.row('T2'), h.state.prop(fx.propertyId)).n, 20)
  assert.equal(rs.value(h.state.row('T3'), h.state.prop(fx.propertyId)).c, 'empty') // empty input -> Empty, not 0
  assert.deepEqual(ids(q({ filter: { kind: 'predicate', propertyId: fx.propertyId, op: 'gt', operand: 5 } })), ['T2'])
  await h.one('property.configure', { propertyId: f.cost, name: 'Budget' })
  assert.equal(h.state.prop(fx.propertyId).config.source, 'prop("Budget") * 2')
  assert.deepEqual(ids(q({ filter: { kind: 'predicate', propertyId: fx.propertyId, op: 'gt', operand: 5 } })), ['T2'])
  // cycles are rejected
  await assert.rejects(h.one('property.create', { sourceId: f.sourceId, name: 'A', kind: 'formula', config: { source: 'prop("Double") + 1' } }).then(async (a) => h.one('property.configure', { propertyId: fx.propertyId, configPatch: { source: 'prop("A")' } })), (e) => e.code === 'CYCLE')
})
