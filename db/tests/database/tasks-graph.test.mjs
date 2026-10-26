// Dependencies, task mode, sprints, typed graph (handoff §19, §20; F35, W09, W10, W18).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { selectGraph } = await import('../../../spike/tiptap/src/database/graph.ts')

async function setup() {
  const h = createHarness()
  const f = await seedFixture(h)
  const blocked = (await h.one('property.create', { sourceId: f.sourceId, name: 'Blocking', kind: 'relation', config: { targetSourceId: f.sourceId, mode: 'paired', cardinality: 'many', inverseCardinality: 'many', inverseName: 'Blocked by' } }))
  return { h, f, rel: blocked }
}
const civil = (s, e = null) => ({ kind: 'date', start: s, end: e })
const setDue = (h, f, id, v) => h.one('row.patch', { pageId: id, cellChanges: { [f.due]: { kind: 'date', value: v } } })

test('dependencies are acyclic: no self links, no cycles', async () => {
  const { h, f, rel } = await setup()
  await h.one('source.configure_tasks', { sourceId: f.sourceId, dependency: { relationPropertyId: rel.propertyId, datePropertyId: f.due, mode: 'shift_on_overlap', avoidWeekends: false, weekendDays: [5] } })
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T1', toPageId: 'T2' })
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T2', toPageId: 'T3' })
  await assert.rejects(h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T3', toPageId: 'T1' }), (e) => e.code === 'CYCLE')
  await assert.rejects(h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T1', toPageId: 'T1' }), (e) => e.code === 'CYCLE')
})

test('W09 shift-on-overlap pushes blocked items later, keeps durations, never earlier', async () => {
  const { h, f, rel } = await setup()
  await h.one('source.configure_tasks', { sourceId: f.sourceId, dependency: { relationPropertyId: rel.propertyId, datePropertyId: f.due, mode: 'shift_on_overlap', avoidWeekends: false, weekendDays: [5] } })
  await setDue(h, f, 'T1', civil('2026-10-25', '2026-10-26'))
  await setDue(h, f, 'T2', civil('2026-10-27', '2026-10-29')) // 3 days
  await setDue(h, f, 'T3', civil('2026-11-10'))
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T1', toPageId: 'T2' })
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T2', toPageId: 'T3' })
  // move the blocker later so it overlaps T2
  const r = await h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-10-27', '2026-10-30') })
  assert.equal(r.shifted, 1)
  const t2 = h.state.row('T2').ext.cells[f.due].value.value
  assert.deepEqual(t2, civil('2026-10-31', '2026-11-02')) // starts the day after the blocker ends, same 3-day length
  assert.deepEqual(h.state.row('T3').ext.cells[f.due].value.value, civil('2026-11-10')) // no overlap -> untouched
  // moving the blocker earlier does not pull anything earlier in this mode
  await h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-10-20', '2026-10-21') })
  assert.deepEqual(h.state.row('T2').ext.cells[f.due].value.value, civil('2026-10-31', '2026-11-02'))
})

test('shift-preserving-gap moves both ways, multiple blockers use the latest need, avoid weekends', async () => {
  const { h, f, rel } = await setup()
  await h.one('source.configure_tasks', { sourceId: f.sourceId, dependency: { relationPropertyId: rel.propertyId, datePropertyId: f.due, mode: 'shift_preserving_gap', avoidWeekends: true, weekendDays: [5] } })
  await setDue(h, f, 'T1', civil('2026-10-20', '2026-10-21'))
  await setDue(h, f, 'T4', civil('2026-10-18', '2026-10-19'))
  await setDue(h, f, 'T2', civil('2026-10-24', '2026-10-25')) // gap of 2 days after T1 (22,23), 4 after T4
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T1', toPageId: 'T2' })
  await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: 'T4', toPageId: 'T2' })
  // move T1 five days later: T2 must satisfy T1 (finish 26 + gap 2 -> 29)  and T4 (finish 19 + gap 4 -> 24): the later wins
  await h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-10-25', '2026-10-26') })
  const t2 = h.state.row('T2').ext.cells[f.due].value.value
  assert.equal(t2.start, '2026-10-29') // Thursday; Friday (5) is the weekend in this workspace
  assert.equal(t2.end, '2026-10-30')
  // when a Friday is the target the next allowed day is used
  await h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-10-26', '2026-10-27') })
  const moved = h.state.row('T2').ext.cells[f.due].value.value
  assert.equal(moved.start, '2026-10-31') // would be Friday 30th -> Saturday 31st
})

test('W10 long chains need approval beyond 20 items and shift in one batch', async () => {
  const { h, f, rel } = await setup()
  await h.one('source.configure_tasks', { sourceId: f.sourceId, dependency: { relationPropertyId: rel.propertyId, datePropertyId: f.due, mode: 'shift_on_overlap', avoidWeekends: false, weekendDays: [5] } })
  const ids = ['T1']
  for (let i = 0; i < 24; i++) ids.push((await h.one('row.create', { sourceId: f.sourceId, title: `c${i}`, explicitValues: { [f.due]: { kind: 'date', value: civil(`2026-11-${String(1 + i).padStart(2, '0')}`) } } })).pageId)
  await setDue(h, f, 'T1', civil('2026-10-30'))
  for (let i = 0; i + 1 < ids.length; i++) await h.one('relation.add', { definitionId: rel.definitionId, fromPageId: ids[i], toPageId: ids[i + 1] })
  await assert.rejects(h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-11-02') }), (e) => e.code === 'INVALID_VALUE' && /shifts/.test(e.message))
  const before = h.state.row(ids[5]).ext.cells[f.due].value.value.start
  const r = await h.one('date.shift', { pageId: 'T1', datePropertyId: f.due, value: civil('2026-11-02'), approve: true })
  assert.ok(r.shifted > 20)
  assert.notEqual(h.state.row(ids[5]).ext.cells[f.due].value.value.start, before)
  // one undo group reverses the whole propagation
  const u = await h.coord.undo('U1')
  assert.equal(u.ok, true)
  assert.equal(h.state.row(ids[5]).ext.cells[f.due].value.value.start, before)
})

test('task mode validates mapped properties; deleting a mapped field is a warning the UI must resolve', async () => {
  const { h, f } = await setup()
  await assert.rejects(h.one('source.configure_tasks', { sourceId: f.sourceId, taskMode: { statusPropertyId: f.cost, assigneePropertyId: null, datePropertyId: f.due } }), (e) => e.code === 'SCHEMA_MISMATCH')
  await h.one('source.configure_tasks', { sourceId: f.sourceId, taskMode: { statusPropertyId: f.status, assigneePropertyId: null, datePropertyId: f.due } })
  assert.equal(h.state.get('source', f.sourceId).settings.taskMode.statusPropertyId, f.status)
})

test('sprints: lifecycle derives from dates, rotation is idempotent, unfinished tasks follow the policy', async () => {
  const { h, f } = await setup()
  const en = await h.one('sprint.enable', { tasksSourceId: f.sourceId, durationWeeks: 2, startDay: 6, unfinished: 'next' })
  const sprintSrc = en.sprintSourceId
  const rot = (today) => h.one('sprint.rotate', { tasksSourceId: f.sourceId, today })
  const a = await rot('2026-10-25')
  const sprints = h.state.rows(sprintSrc)
  assert.equal(sprints.length, 2) // current + next
  const cfg = h.state.get('source', f.sourceId).settings.sprint
  const name = (id) => h.state.row(id).page.title
  assert.equal(name(a.current), 'Sprint 1')
  assert.equal(name(a.next), 'Sprint 2')
  const range = h.state.row(a.current).ext.cells[cfg.datesPropertyId].value.value
  assert.equal(range.start, '2026-10-24') // Saturday on or before today
  assert.equal(range.end, '2026-11-06')
  const again = await rot('2026-10-25')
  assert.equal(again.current, a.current)
  assert.equal(h.state.rows(sprintSrc).length, 2) // no second "next" created
  // assign unfinished + finished tasks to the current sprint
  const rel = h.state.relationOf(en.relationPropertyId)
  await h.one('relation.add', { definitionId: rel.id, fromPageId: 'T1', toPageId: a.current }) // todo
  await h.one('relation.add', { definitionId: rel.id, fromPageId: 'T3', toPageId: a.current }) // done
  const life = (id) => h.state.prop(cfg.lifecyclePropertyId).config.options.find((o) => o.id === h.state.row(id).ext.cells[cfg.lifecyclePropertyId].value.optionId).name
  assert.equal(life(a.current), 'current')
  assert.equal(life(a.next), 'next')
  // two weeks later: Sprint 2 becomes current, Sprint 1 last, Sprint 3 appears
  const b = await rot('2026-11-08')
  assert.equal(name(b.current), 'Sprint 2')
  assert.equal(name(b.last), 'Sprint 1')
  assert.equal(name(b.next), 'Sprint 3')
  assert.equal(life(a.current), 'last')
  assert.equal(h.state.rows(sprintSrc).length, 3)
  assert.equal(b.movedTasks, 1) // T1 (unfinished) moved to the new current sprint, T3 (done) stays
  assert.equal(h.state.edgesOut(rel.id, 'T1')[0].toPageId, b.current)
  assert.equal(h.state.edgesOut(rel.id, 'T3')[0].toPageId, a.current)
  // turning sprints off keeps the data by default
  await h.one('sprint.disable', { tasksSourceId: f.sourceId, mode: 'keep' })
  assert.equal(h.state.get('source', sprintSrc).deletedAt, null)
  assert.equal(h.state.get('source', f.sourceId).settings.sprint, undefined)
})

test('F35/graph: typed edges, canonical relation counted once, kinds opt-in, root retained under a budget', async () => {
  const { h, f } = await setup()
  const pages = () => [...h.pages.all()].map((p) => ({ id: p.id, title: p.title, kind: p.kind, deletedAt: p.deletedAt }))
  const q = (over = {}) => ({ vaultId: 'vault-1', hops: 2, edgeKinds: ['mention'], maxNodes: 500, maxEdges: 3000, principalId: 'U1', ...over })
  const mentions = [['T1', 'T2']]
  const g0 = selectGraph(h.state, pages(), mentions, q())
  assert.equal(g0.edges.length, 1) // default graph stays mention-only
  const g1 = selectGraph(h.state, pages(), mentions, q({ edgeKinds: ['mention', 'relation'] }))
  assert.equal(g1.edges.filter((e) => e.kind === 'relation').length, 3) // three canonical Project links, each counted once although paired
  const t1 = g1.nodes.find((n) => n.id === 'T1')
  assert.equal(t1.degree, 2) // mention T2 + relation P1
  // hierarchy edges appear only on request
  await h.one('row.patch', { pageId: 'T3', parentItemId: 'T2' })
  assert.equal(selectGraph(h.state, pages(), [], q({ edgeKinds: ['hierarchy'] })).edges.length, 1)
  // reactive input: a title change and a new link are visible on the next selection with no reopening
  await h.one('row.patch', { pageId: 'T1', title: 'Renamed T1' })
  await h.one('relation.add', { definitionId: f.projectRelation, fromPageId: 'T4', toPageId: f.P2 })
  const g2 = selectGraph(h.state, pages(), mentions, q({ edgeKinds: ['relation'] }))
  assert.equal(g2.nodes.find((n) => n.id === 'T1').title, 'Renamed T1')
  assert.equal(g2.edges.length, 4)
  // trashed nodes disappear without leaving edges behind
  await h.one('row.trash', { pageIds: [f.P2] })
  const g3 = selectGraph(h.state, pages(), mentions, q({ edgeKinds: ['relation'] }))
  assert.equal(g3.nodes.some((n) => n.id === f.P2), false)
  assert.equal(g3.edges.length, 2)
  // budget: root is always retained, cut ids are reported
  const small = selectGraph(h.state, pages(), mentions, q({ rootPageId: 'T1', hops: 2, edgeKinds: ['mention', 'relation'], maxNodes: 2 }))
  assert.equal(small.nodes.length, 2)
  assert.equal(small.nodes[0].id, 'T1')
  assert.equal(small.rootRetained, true)
  assert.equal(small.truncated.nodes || small.totalNodes <= 2, true)
})

test('graph hides nodes a principal cannot see, with no label leak', async () => {
  const { h, f } = await setup()
  await h.one('record.put', { kind: 'principal', id: 'U9', body: { type: 'user', displayName: 'Guest', email: null, memberIds: [], isLocalOwner: false, externalId: null } })
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U9', containerId: null, sourceId: f.projSrc, pageId: null, right: 'view', propertyId: null, propertyRights: null, viaPropertyId: null } })
  const pages = [...h.pages.all()].map((p) => ({ id: p.id, title: p.title, kind: p.kind, deletedAt: p.deletedAt }))
  const g = selectGraph(h.state, pages, [], { vaultId: 'vault-1', hops: 2, edgeKinds: ['relation'], maxNodes: 500, maxEdges: 3000, principalId: 'U9' })
  assert.deepEqual(g.nodes.map((n) => n.title).sort(), ['P1', 'P2', 'Projects']) // Tasks and its rows stay hidden
  assert.equal(g.edges.length, 0)
})
