// Templates, repeats, moving rows, duplicate (handoff §13, §18; W01-W05, M14, R06-R07).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { repeatOccurrences } = await import('../../../spike/tiptap/src/database/repeat.ts')

async function setup() {
  const h = createHarness()
  const f = await seedFixture(h)
  const tpl = (body) => h.one('record.put', { kind: 'template', body: { sourceId: f.sourceId, name: 'T', icon: null, cover: null, defaults: {}, body: null, nested: [], repeat: null, scheduleVersion: 1, ...body } })
  return { h, f, tpl }
}
const para = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })

test('W01 a template yields an independent row: body copied, defaults applied, no shared state', async () => {
  const { h, f, tpl } = await setup()
  const t = await tpl({ defaults: { [f.cost]: { kind: 'number', value: 9 } }, body: para('from template'), icon: 'i:star' })
  const a = await h.one('template.apply', { templateId: t.id, createInSourceId: f.sourceId })
  const b = await h.one('template.apply', { templateId: t.id, createInSourceId: f.sourceId })
  assert.notEqual(a.pageId, b.pageId)
  assert.equal(h.state.row(a.pageId).ext.cells[f.cost].value.value, 9)
  assert.equal(h.state.row(a.pageId).page.content.content[0].content[0].text, 'from template')
  assert.equal(h.state.row(a.pageId).page.icon, 'i:star')
  await h.one('row.patch', { pageId: a.pageId, cellChanges: { [f.cost]: { kind: 'number', value: 1 } } })
  assert.equal(h.state.row(b.pageId).ext.cells[f.cost].value.value, 9)
})

test('applying a template to an existing row never overwrites silently', async () => {
  const { h, f, tpl } = await setup()
  const t = await tpl({ defaults: { [f.cost]: { kind: 'number', value: 9 }, [f.notes]: { kind: 'text', runs: [{ text: 'tpl' }] } }, body: para('tpl body') })
  await h.one('template.apply', { templateId: t.id, pageId: 'T2' }) // fill_empty by default
  assert.equal(h.state.row('T2').ext.cells[f.cost].value.value, 10) // kept
  assert.equal(h.state.row('T2').ext.cells[f.notes].value.runs[0].text, '   ') // kept (whitespace is not empty)
  await h.one('template.apply', { templateId: t.id, pageId: 'T1' })
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.runs[0].text, 'tpl') // empty -> filled
  assert.equal(h.state.row('T1').ext.cells[f.cost].value.value, 0) // zero is a value, kept
  assert.equal(h.state.row('T1').page.content.content.length >= 1, true)
  await h.one('template.apply', { templateId: t.id, pageId: 'T2', valuePolicy: 'overwrite', bodyMode: 'replace' })
  assert.equal(h.state.row('T2').ext.cells[f.cost].value.value, 9)
  assert.equal(h.state.row('T2').page.content.content[0].content[0].text, 'tpl body')
})

test('view default template wins over the source default; deleting a template keeps existing rows', async () => {
  const { h, f, tpl } = await setup()
  const a = await tpl({ name: 'A', defaults: { [f.cost]: { kind: 'number', value: 1 } } })
  const b = await tpl({ name: 'B', defaults: { [f.cost]: { kind: 'number', value: 2 } } })
  await h.one('template.set_default', { sourceId: f.sourceId, templateId: a.id })
  await h.one('view.patch', { viewId: f.viewId, defaultTemplateId: b.id })
  const r1 = await h.one('row.create', { sourceId: f.sourceId, viewId: f.viewId })
  assert.equal(h.state.row(r1.pageId).ext.cells[f.cost].value.value, 2)
  const r2 = await h.one('row.create', { sourceId: f.sourceId })
  assert.equal(h.state.row(r2.pageId).ext.cells[f.cost].value.value, 1)
  await h.one('record.trash', { kind: 'template', id: b.id })
  assert.equal(h.state.row(r1.pageId).ext.cells[f.cost].value.value, 2)
})

test('W03/nested: placeholder links are remapped to the rows created with the template', async () => {
  const { h, f, tpl } = await setup()
  const inner = await h.one('record.put', { kind: 'template', body: { sourceId: f.projSrc, name: 'inner', icon: null, cover: null, defaults: {}, body: null, nested: [], repeat: null, scheduleVersion: 1 } })
  const t = await tpl({ nested: [{ sourceId: f.projSrc, templateId: inner.id }], body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: '{{nested:0}}' } }] }] } })
  const r = await h.one('template.apply', { templateId: t.id, createInSourceId: f.sourceId })
  const linked = h.state.row(r.pageId).page.content.content[0].content[0].attrs.id
  assert.equal(linked, r.nested[0])
  assert.equal(h.state.row(linked).sourceId, f.projSrc)
})

test('W04/W05 repeats: stable occurrence keys, one catch-up, >30 needs approval, restart does not duplicate', async () => {
  const { h, f, tpl } = await setup()
  const t = await tpl({ repeat: { frequency: 'daily', interval: 1, startDate: '2026-10-01', endDate: null, time: '09:00', timeZone: 'Asia/Tehran' } })
  // 24 days between Oct 1 and Oct 25 -> inside the 30 limit
  const r = await h.one('template.run_repeats', { now: '2026-10-25T08:00:00Z' })
  assert.equal(r[0].created, 25 - 1 + 0 + (Date.parse('2026-10-25T05:30:00Z') <= Date.parse('2026-10-25T08:00:00Z') ? 1 : 0)) // Oct 1..25 09:00 local (= 05:30Z) all <= now
  const n = h.state.rows(f.sourceId).length
  const again = await h.one('template.run_repeats', { now: '2026-10-25T08:00:00Z' })
  assert.equal(again[0].created, 0)
  assert.equal(h.state.rows(f.sourceId).length, n)
  // a long gap needs approval
  const far = await h.one('template.run_repeats', { now: '2027-03-01T08:00:00Z' })
  assert.equal(far[0].created, 0)
  assert.ok(far[0].pending > 30)
  const ok = await h.one('template.run_repeats', { now: '2027-03-01T08:00:00Z', approveMany: true })
  assert.equal(ok[0].created, far[0].pending)
  void t
})

test('repeat schedules: weekly weekdays, monthly clamp to last day, yearly leap day, DST gap', async () => {
  const w = repeatOccurrences({ frequency: 'weekly', interval: 1, startDate: '2026-10-01', endDate: null, time: '09:00', timeZone: 'UTC', weekdays: [1, 3] }, 't', 1, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-15T00:00:00Z'))
  assert.deepEqual(w.map((o) => o.civil), ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14'])
  const m = repeatOccurrences({ frequency: 'monthly', interval: 1, startDate: '2026-01-31', endDate: null, time: '10:00', timeZone: 'UTC', dayOfMonth: 31 }, 't', 1, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-05-31T23:59:00Z'))
  assert.deepEqual(m.map((o) => o.civil), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
  const y = repeatOccurrences({ frequency: 'yearly', interval: 1, startDate: '2028-02-29', endDate: null, time: '08:00', timeZone: 'UTC' }, 't', 1, Date.parse('2028-01-01T00:00:00Z'), Date.parse('2030-12-31T00:00:00Z'))
  assert.deepEqual(y.map((o) => o.civil), ['2028-02-29', '2029-02-28', '2030-02-28'])
  const dst = repeatOccurrences({ frequency: 'daily', interval: 1, startDate: '2026-03-07', endDate: null, time: '02:30', timeZone: 'America/New_York' }, 't', 1, Date.parse('2026-03-07T00:00:00Z'), Date.parse('2026-03-10T00:00:00Z'))
  assert.equal(dst.find((o) => o.civil === '2026-03-08').adjusted, true)
  const keys = new Set(dst.map((o) => o.key))
  assert.equal(keys.size, dst.length) // stable, unique keys
  const ended = repeatOccurrences({ frequency: 'daily', interval: 2, startDate: '2026-10-01', endDate: '2026-10-05', time: '09:00', timeZone: 'UTC' }, 't', 1, Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-12-01T00:00:00Z'))
  assert.deepEqual(ended.map((o) => o.civil), ['2026-10-01', '2026-10-03', '2026-10-05'])
})

test('M14 moving rows: explicit same-kind mapping, unmapped cells archived, invalid edges reviewed, page id and body preserved', async () => {
  const { h, f } = await setup()
  const other = await h.one('source.create', { ownerContainerId: f.containerId, name: 'Other' })
  const cost2 = (await h.one('property.create', { sourceId: other.sourceId, name: 'Price', kind: 'number' })).propertyId
  await h.one('page.patch_body', { pageId: 'T2', content: para('keep me') })
  const before = h.state.row('T2').page.parentId
  // T2 has a Project link: moving without a decision is rejected
  await assert.rejects(h.one('row.move', { pageIds: ['T2'], destinationSourceId: other.sourceId, mapping: { [f.cost]: cost2 } }), (e) => e.code === 'SCHEMA_MISMATCH')
  // kind mismatch is rejected too
  await assert.rejects(h.one('row.move', { pageIds: ['T2'], destinationSourceId: other.sourceId, mapping: { [f.notes]: cost2 }, edgePolicy: 'archive_invalid' }), (e) => e.code === 'SCHEMA_MISMATCH')
  const edgesBefore = h.state.live('edge').length
  const res = await h.one('row.move', { pageIds: ['T2'], destinationSourceId: other.sourceId, mapping: { [f.cost]: cost2 }, edgePolicy: 'archive_invalid' })
  assert.equal(res.archivedEdges, 1)
  assert.equal(h.state.live('edge').length, edgesBefore - 1)
  const row = h.state.row('T2')
  assert.equal(row.sourceId, other.sourceId)
  assert.equal(row.ext.cells[cost2].value.value, 10)
  assert.equal(row.ext.cells[f.cost], undefined)
  assert.equal(row.page.content.content[0].content[0].text, 'keep me')
  assert.equal(row.page.parentId, before) // Explorer position unchanged
  assert.ok(Object.keys(row.ext.archivedCells).length >= 1) // status, tags, dates... archived rather than dropped
  assert.equal(h.state.rows(f.sourceId).some((r) => r.page.id === 'T2'), false)
})

test('R06/R07 duplicate: new ids, external links retained, sub-item subtree remapped, unique ids reallocated', async () => {
  const { h, f } = await setup()
  await h.one('property.create', { sourceId: f.sourceId, name: 'Key', kind: 'unique_id', config: { prefix: 'TSK', allocationMode: 'sequential' } })
  await h.one('row.patch', { pageId: 'T3', parentItemId: 'T2' })
  const res = await h.one('row.duplicate', { rootPageIds: ['T2'] })
  const m = res.mapping
  assert.equal(Object.keys(m).length, 2) // T2 and its sub-item T3
  assert.equal(h.state.row(m.T3).ext.parentItemId, m.T2) // internal link remapped
  assert.equal(h.state.row(m.T2).page.title, 'T2')
  const e = h.state.live('edge').filter((x) => x.fromPageId === m.T2)
  assert.equal(e.length, 1) // external link to P1 retained
  assert.equal(e[0].toPageId, f.P1)
  const keyId = h.state.props(f.sourceId).find((p) => p.kind === 'unique_id').id
  assert.notEqual(h.state.row(m.T2).ext.allocatedIds[keyId], h.state.row('T2').ext.allocatedIds[keyId])
})

test('sub-items: no self or ancestor cycles; trashing a parent takes the subtree; restore brings it back', async () => {
  const { h } = await setup()
  await h.one('row.patch', { pageId: 'T2', parentItemId: 'T1' })
  await h.one('row.patch', { pageId: 'T3', parentItemId: 'T2' })
  await assert.rejects(h.one('row.patch', { pageId: 'T1', parentItemId: 'T3' }), (e) => e.code === 'CYCLE')
  await assert.rejects(h.one('row.patch', { pageId: 'T1', parentItemId: 'T1' }), (e) => e.code === 'CYCLE')
  const r = await h.one('row.trash', { pageIds: ['T1'] })
  assert.equal(r.count, 3)
  assert.equal(h.state.pages.get('T3').deletedAt !== null, true)
  await h.one('row.restore', { pageIds: ['T1'] })
  assert.equal(h.state.pages.get('T3').deletedAt, null)
})

test('purge needs a fresh preview token and keeps edge tombstones', async () => {
  const { h } = await setup()
  const { purgeToken } = await import('../../../spike/tiptap/src/database/commands/rows.ts')
  await h.one('row.trash', { pageIds: ['T1'] })
  await assert.rejects(h.one('row.purge', { pageIds: ['T1'], previewToken: 'wrong' }), (e) => e.code === 'INVALID_VALUE')
  await h.one('row.purge', { pageIds: ['T1'], previewToken: purgeToken(['T1']) })
  assert.equal(h.state.pages.get('T1'), undefined)
  assert.ok(h.state.all('edge').some((e) => e.fromPageId === 'T1' && e.deletedAt !== null))
})

test('limits: 2.5 MiB per row and 1 MiB per text cell are hard errors, nothing partial is saved', async () => {
  const { h, f } = await setup()
  const huge = 'x'.repeat(600_000) // 1.2 MB as UTF-16
  await assert.rejects(h.one('row.patch', { pageId: 'T1', cellChanges: { [f.notes]: { kind: 'text', runs: [{ text: huge }] } } }), (e) => e.code === 'QUOTA')
  assert.equal(h.state.row('T1').ext.cells[f.notes], undefined)
})
