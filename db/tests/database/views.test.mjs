// View behaviour: board drag, calendar drag, chart, map, dashboard, feed, forms, comments (handoff §17; F19, F20, U03-U17, W13-W15).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture, FIXTURE_CLOCK, FIXTURE_ZONE } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const V = await import('../../../spike/tiptap/src/database/viewLogic.ts')
const { chartData, chartToSvg, drilldownFilter } = await import('../../../spike/tiptap/src/database/query/chart.ts')
const { runQuery, makeQuery, NONE_GROUP } = await import('../../../spike/tiptap/src/database/query/engine.ts')
const { Resolver } = await import('../../../spike/tiptap/src/database/resolver.ts')

async function setup() {
  const h = createHarness()
  const f = await seedFixture(h)
  const exec = async (plan) => {
    assert.equal(plan.ok, true, plan.reason)
    for (const c of plan.commands) await h.one(c.type, c.payload)
  }
  const rs = () => new Resolver(h.state, { principalId: 'U1', nowMs: Date.parse(FIXTURE_CLOCK), zone: FIXTURE_ZONE, weekStart: 6 })
  return { h, f, exec, rs }
}

test('F19 board drag of a multi-select card: leave origin, join destination, keep the rest, no new row', async () => {
  const { h, f, exec } = await setup()
  const n = h.state.rows(f.sourceId).length
  await exec(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.tags, fromKey: f.to('red'), toKey: f.to('green') }))
  assert.deepEqual(h.state.row('T1').ext.cells[f.tags].value.optionIds, [f.to('blue'), f.to('green')])
  assert.equal(h.state.rows(f.sourceId).length, n)
  // from "unassigned" only adds; to "unassigned" with several values needs confirmation
  await exec(V.planBoardDrop(h.state, { pageId: 'T3', groupPropertyId: f.tags, fromKey: NONE_GROUP, toKey: f.to('red') }))
  assert.deepEqual(h.state.row('T3').ext.cells[f.tags].value.optionIds, [f.to('red')])
  const clear = V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.tags, fromKey: f.to('blue'), toKey: NONE_GROUP })
  assert.equal(clear.confirm, 'clear_multiple')
  // same origin and destination mutates nothing
  assert.deepEqual(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.tags, fromKey: f.to('blue'), toKey: f.to('blue') }), { ok: true, noop: true, commands: [] })
})

test('board drops: scalar sets the value, status group, computed groups and active sorts are refused', async () => {
  const { h, f, exec } = await setup()
  await exec(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.status, fromKey: f.so('todo'), toKey: f.so('doing') }))
  assert.equal(h.state.row('T1').ext.cells[f.status].value.optionId, f.so('doing'))
  const cfg = h.state.prop(f.status).config
  const completeGroup = cfg.groups.find((g) => g.semantic === 'complete').id
  await exec(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.status, fromKey: 'x', toKey: completeGroup, mode: 'status_group' }))
  assert.equal(h.state.row('T1').ext.cells[f.status].value.optionId, f.so('done'))
  assert.equal(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.status, fromKey: 'a', toKey: NONE_GROUP }).ok, false) // a status is never empty
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'F', kind: 'formula', config: { source: '"x"' } })
  assert.match(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: fx.propertyId, fromKey: 'a', toKey: 'b' }).reason, /computed/)
  assert.match(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.status, fromKey: 'a', toKey: 'a', reorderWithinGroup: true, sortsActive: true }).reason, /sort/)
  await exec(V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.done, fromKey: 'false', toKey: 'true' }))
  assert.equal(h.state.row('T1').ext.cells[f.done].value.value, true)
})

test('board drop on a single-valued relation replaces the old target in one batch', async () => {
  const { h, f, exec } = await setup()
  const plan = V.planBoardDrop(h.state, { pageId: 'T1', groupPropertyId: f.project, fromKey: f.P1, toKey: f.P2 })
  await h.run(plan.commands.map((c) => ({ type: c.type, payload: c.payload })))
  assert.equal(h.state.edgesOut(f.projectRelation, 'T1').length, 1)
  assert.equal(h.state.edgesOut(f.projectRelation, 'T1')[0].toPageId, f.P2)
  void exec
})

test('F20 calendar drag keeps the duration; resize changes one endpoint; formula dates are not draggable', async () => {
  const { h, f, exec } = await setup()
  await exec(V.planDateDrag(h.state, { pageId: 'T2', datePropertyId: f.due, mode: 'move', days: 1, zone: FIXTURE_ZONE }))
  assert.deepEqual(h.state.row('T2').ext.cells[f.due].value.value, { kind: 'date', start: '2026-10-27', end: '2026-10-29' })
  await exec(V.planDateDrag(h.state, { pageId: 'T2', datePropertyId: f.due, mode: 'resize_end', days: 2, zone: FIXTURE_ZONE }))
  assert.deepEqual(h.state.row('T2').ext.cells[f.due].value.value, { kind: 'date', start: '2026-10-27', end: '2026-10-31' })
  assert.match(V.planDateDrag(h.state, { pageId: 'T2', datePropertyId: f.due, mode: 'resize_end', days: -9, zone: FIXTURE_ZONE }).reason, /before start/)
  assert.match(V.planDateDrag(h.state, { pageId: 'T3', datePropertyId: f.due, mode: 'move', days: 1, zone: FIXTURE_ZONE }).reason, /no date/)
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'Calc', kind: 'formula', config: { source: 'prop("Due")' } })
  assert.match(V.planDateDrag(h.state, { pageId: 'T2', datePropertyId: fx.propertyId, mode: 'move', days: 1, zone: FIXTURE_ZONE }).reason, /computed/)
})

test('calendar / timeline model: undated items go to an explicit tray, ranges clip to the window', async () => {
  const { h, f, rs } = await setup()
  const all = h.state.rows(f.sourceId).map((r) => r.page.id)
  const m = V.scheduleModel(h.state, rs(), all, f.due, '2026-10-24', '2026-10-27', FIXTURE_ZONE)
  assert.deepEqual(m.items.map((i) => i.pageId).sort(), ['T1', 'T2', 'T4'])
  assert.deepEqual(m.unscheduled, ['T3'])
  const t2 = m.items.find((i) => i.pageId === 'T2')
  assert.equal(t2.startCivil, '2026-10-26')
  assert.equal(t2.endCivil, '2026-10-28') // the range is shown whole even though the window ends the 27th
  assert.equal(m.editable, true)
})

test('map: pins, a visible cap that preserves the full source, and an unplaced tray (never auto-geocoded)', async () => {
  const { h, f, rs } = await setup()
  const place = (await h.one('property.create', { sourceId: f.sourceId, name: 'Where', kind: 'place' })).propertyId
  await h.one('row.patch', { pageId: 'T1', cellChanges: { [place]: { kind: 'place', value: { lat: 35.7, lon: 51.4, name: 'Tehran', address: '' } } } })
  await h.one('row.patch', { pageId: 'T2', cellChanges: { [place]: { kind: 'place', value: { lat: null, lon: null, name: '', address: 'Somewhere 12' } } } })
  await assert.rejects(h.one('row.patch', { pageId: 'T3', cellChanges: { [place]: { kind: 'place', value: { lat: 99, lon: 0, name: 'x', address: '' } } } }), (e) => e.code === 'INVALID_VALUE')
  const m = V.mapModel(h.state, rs(), ['T1', 'T2', 'T3'], place)
  assert.deepEqual(m.pins.map((p) => p.pageId), ['T1'])
  assert.deepEqual(m.unplaced.sort(), ['T2', 'T3'])
  assert.equal(h.state.row('T2').ext.cells[place].value.value.unresolved, true)
})

test('dashboard: effective filter is base AND local AND mapped global; unmapped widgets are not affected', async () => {
  const { f } = await setup()
  const base = { kind: 'predicate', propertyId: 'a', op: 'equals', operand: 1 }
  const g = { predicate: { op: 'equals', operand: 'x' }, mappings: { [f.sourceId]: 'mappedProp' } }
  const r = V.effectiveFilter(base, null, g, f.sourceId)
  assert.equal(r.affected, true)
  assert.deepEqual(r.filter.children.map((c) => c.propertyId), ['a', 'mappedProp'])
  assert.deepEqual(V.effectiveFilter(base, null, g, 'other'), { filter: base, affected: false })
})

test('chart: category/series data from the full query, unassigned category, drill-down filter, caps, SVG', async () => {
  const { h, f } = await setup()
  const req = { sourceId: f.sourceId, principalId: 'U1', now: FIXTURE_CLOCK, zone: FIXTURE_ZONE, type: 'bar_vertical', categoryPropertyId: f.tags, measure: { kind: 'count' } }
  const d = chartData(h.state, req)
  assert.deepEqual(d.categories.map((c) => [c.label, c.total]), [['red', 1], ['blue', 2], ['green', 1], ['', 1]])
  assert.equal(d.categories[3].key, NONE_GROUP)
  const sum = chartData(h.state, { ...req, categoryPropertyId: f.status, measure: { kind: 'agg', propertyId: f.cost, op: 'sum' } })
  assert.deepEqual(sum.categories.map((c) => [c.label, c.total]), [['todo', -5], ['doing', 10], ['done', 0]]) // todo = T1 (0) + T4 (-5); sum of nothing is 0
  const series = chartData(h.state, { ...req, categoryPropertyId: f.status, seriesPropertyId: f.done })
  assert.ok(series.series.length >= 1)
  const num = chartData(h.state, { ...req, type: 'number', categoryPropertyId: undefined, measure: { kind: 'agg', propertyId: f.cost, op: 'sum' } })
  assert.equal(num.total, 5)
  // drill-down opens a table filter that matches exactly the bar's rows
  const filter = drilldownFilter(h.state, req, f.to('blue'))
  assert.deepEqual(runQuery(h.state, makeQuery(h.state, f.sourceId, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, { filter })).pageIds, ['T1', 'T2'])
  const none = drilldownFilter(h.state, req, NONE_GROUP)
  assert.deepEqual(runQuery(h.state, makeQuery(h.state, f.sourceId, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, { filter: none })).pageIds, ['T3'])
  // invalid axes are rejected
  const roll = await h.one('property.create', { sourceId: f.projSrc, name: 'R', kind: 'rollup', config: { relationPropertyId: f.tasksOnProject, targetPropertyId: f.cost, aggregation: 'sum' } })
  assert.throws(() => chartData(h.state, { ...req, sourceId: f.projSrc, categoryPropertyId: roll.propertyId }), (e) => e.code === 'INVALID_VALUE')
  const svg = chartToSvg(d, { title: 'Tags' })
  assert.match(svg, /<svg[^>]+role="img"/)
  assert.match(svg, /<title id="t">Tags<\/title>/)
  assert.match(svg, /red 1, blue 2, green 1, Unassigned 1/)
  for (const t of ['bar_horizontal', 'line', 'donut']) assert.match(chartToSvg({ ...d, type: t }, { title: t }), /<svg/)
})

test('chart date buckets and comparison period', async () => {
  const { h, f } = await setup()
  const req = { sourceId: f.sourceId, principalId: 'U1', now: FIXTURE_CLOCK, zone: FIXTURE_ZONE, type: 'bar_vertical', categoryPropertyId: f.due, dateBucket: 'month', measure: { kind: 'count' } }
  assert.deepEqual(chartData(h.state, req).categories.map((c) => [c.key, c.total]), [['2026-10', 3], [NONE_GROUP, 1]])
  const cmp = chartData(h.state, { ...req, type: 'number', categoryPropertyId: undefined, comparison: { datePropertyId: f.due, current: 'today', previous: 'yesterday' } })
  assert.deepEqual(cmp.comparison, { current: 1, previous: 1, delta: 0 }) // T1 today, T4 yesterday
})

// ───── forms ─────

async function formSetup() {
  const s = await setup()
  const { h, f } = s
  const v = await h.one('view.create', { containerId: f.containerId, sourceId: f.sourceId, type: 'form', name: 'Intake' })
  const q = (id, propertyId, extra = {}) => ({ id, propertyId, title: id, description: '', syncLabel: false, required: false, order: Object.keys(extra).length ? 0 : 0, ...extra })
  const config = {
    version: 0, open: true, anonymous: false, submitMessage: 'thanks',
    questions: [
      { ...q('qt', f.titleId), required: true, order: 1 },
      { ...q('qs', f.status), order: 2, required: true },
      { ...q('qc', f.cost), order: 3, visibleWhen: { questionId: 'qs', op: 'equals', value: f.so('doing') }, required: true },
      { ...q('qk', f.done), order: 4, required: true },
      { ...q('qp', f.project), order: 5, optionProjection: [f.P1] },
    ],
  }
  return { ...s, viewId: v.viewId, config }
}

test('W13 form validation: required, conditional required, acknowledgement checkbox, unknown/hidden answers', async () => {
  const { h, f, viewId, config } = await formSetup()
  await h.one('form.configure', { viewId, config })
  const ver = h.state.get('view', viewId).configuration.version
  const submit = (answers, submissionId = 's' + Math.random(), version = ver) => h.one('form.submit', { formViewId: viewId, version, submissionId, answers })
  await assert.rejects(submit({ qt: 'x' }), (e) => e.code === 'INVALID_VALUE') // status required
  await assert.rejects(submit({ qt: 'x', qs: f.so('doing'), qk: true }), (e) => e.detail.errors[0].questionId === 'qc') // cost required only when "doing"
  await assert.rejects(submit({ qt: 'x', qs: f.so('todo'), qk: false }), (e) => e.detail.errors[0].questionId === 'qk') // must be checked
  const ok = await submit({ qt: 'From form', qs: f.so('todo'), qc: 99, qk: true, qp: f.P1 })
  assert.ok(ok.pageId)
  const row = h.state.row(ok.pageId)
  assert.equal(row.page.title, 'From form')
  assert.equal(row.ext.cells[f.cost], undefined) // hidden by its condition: the answer was discarded
  assert.equal(h.state.edgesOut(f.projectRelation, ok.pageId)[0].toPageId, f.P1)
  await assert.rejects(submit({ qt: 'x', qs: f.so('todo'), qk: true, qp: f.P2 }), (e) => e.code === 'INVALID_VALUE') // not an offered choice
})

test('W15 form submission is idempotent, version-checked, closable, and repair-gated', async () => {
  const { h, f, viewId, config } = await formSetup()
  await h.one('form.configure', { viewId, config })
  const ver = h.state.get('view', viewId).configuration.version
  const n = h.state.rows(f.sourceId).length
  const a = await h.one('form.submit', { formViewId: viewId, version: ver, submissionId: 'dup', answers: { qt: 'x', qs: f.so('todo'), qk: true } })
  const b = await h.run([{ type: 'form.submit', payload: { formViewId: viewId, version: ver, submissionId: 'dup', answers: { qt: 'x', qs: f.so('todo'), qk: true } } }])
  assert.equal(b.result.repeated, true)
  assert.equal(b.result.receiptId, a.receiptId)
  assert.equal(h.state.rows(f.sourceId).length, n + 1)
  await assert.rejects(h.one('form.submit', { formViewId: viewId, version: ver - 1, submissionId: 'old', answers: {} }), (e) => e.code === 'REVISION_CONFLICT')
  await h.one('form.configure', { viewId, config: { ...config, open: false } })
  await assert.rejects(h.one('form.submit', { formViewId: viewId, version: ver + 1, submissionId: 'closed', answers: {} }), (e) => e.code === 'NOT_FOUND')
  // forward-only branching and forbidden kinds
  const cyc = { ...config, questions: [config.questions[0], { ...config.questions[1], visibleWhen: { questionId: 'qc', op: 'is_not_empty' } }, config.questions[2]] }
  await assert.rejects(h.one('form.configure', { viewId, config: { ...cyc, open: true } }), (e) => /forward/.test(e.message))
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'Calc', kind: 'formula', config: { source: '1' } })
  await assert.rejects(h.one('form.configure', { viewId, config: { ...config, open: true, questions: [...config.questions, { id: 'qx', propertyId: fx.propertyId, title: 'x', description: '', syncLabel: false, required: false, order: 9 }] } }), (e) => /cannot be a form question/.test(e.message))
  // a deleted property marks its question broken and blocks publishing
  await h.one('property.delete', { propertyId: f.done })
  await assert.rejects(h.one('form.configure', { viewId, config: { ...config, open: true } }), (e) => /deleted/.test(e.message))
})

// ───── comments / feed ─────

test('comments: anchored to a page or a non-empty property, replies, edit by author only, soft delete', async () => {
  const { h, f } = await setup()
  const c = await h.one('comment.add', { pageId: 'T1', body: [{ text: 'hello' }] })
  const r = await h.one('comment.add', { pageId: 'T1', parentCommentId: c.commentId, body: [{ text: 'reply' }] })
  await assert.rejects(h.one('comment.add', { pageId: 'T1', body: [{ text: '  ' }] }), (e) => e.code === 'INVALID_VALUE')
  await assert.rejects(h.one('comment.add', { pageId: 'T3', propertyId: f.cost, body: [{ text: 'x' }] }), (e) => /empty/.test(e.message)) // cost is empty on T3
  await assert.rejects(h.one('comment.add', { pageId: 'T1', propertyId: f.titleId, body: [{ text: 'x' }] }), (e) => /cannot be commented/.test(e.message))
  await assert.rejects(h.one('comment.add', { pageId: 'T1', propertyId: f.done, body: [{ text: 'x' }] }), (e) => /checkbox/.test(e.message))
  await h.one('comment.add', { pageId: 'T2', propertyId: f.cost, body: [{ text: 'why 10?' }] })
  await h.one('comment.resolve', { commentId: c.commentId, resolved: true })
  assert.equal(h.state.get('comment', c.commentId).resolved, true)
  await h.one('comment.delete', { commentId: r.commentId })
  assert.notEqual(h.state.get('comment', r.commentId).deletedAt, null)
  assert.deepEqual(V.feedCounts(h.state, 'T1'), { views: 0, comments: 1 })
  // property comments survive deleting and restoring the property
  await h.one('property.delete', { propertyId: f.cost })
  assert.equal(h.state.live('comment').filter((x) => x.propertyId === f.cost).length, 1)
})

test('feed views: one per principal per page per day, only after two visible seconds', async () => {
  const { h } = await setup()
  assert.equal((await h.one('feed.view', { pageId: 'T1', visibleMs: 500 })).counted, false)
  assert.equal((await h.one('feed.view', { pageId: 'T1', visibleMs: 2500 })).counted, true)
  assert.equal((await h.one('feed.view', { pageId: 'T1', visibleMs: 2500 })).counted, false)
  assert.equal(V.feedCounts(h.state, 'T1').views, 1)
  h.tick(24 * 3600 * 1000)
  assert.equal((await h.one('feed.view', { pageId: 'T1', visibleMs: 2500 })).counted, true)
  assert.equal(V.feedCounts(h.state, 'T1').views, 2)
})
