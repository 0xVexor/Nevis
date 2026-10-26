// Property conversion matrix (handoff §9; F25, F26; V14-V17).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { previewConversion, isConvertible } = await import('../../../spike/tiptap/src/database/commands/convert.ts')

async function setup() {
  const h = createHarness()
  const f = await seedFixture(h)
  for (const id of ['T1', 'T2', 'T3', 'T4']) await h.one('row.patch', { pageId: id, cellChanges: { [f.notes]: null } }) // start from empty notes
  const text = (id, s) => h.one('row.patch', { pageId: id, cellChanges: { [f.notes]: { kind: 'text', runs: s ? [{ text: s }] : [] } } })
  const conv = (over) => h.one('property.convert_commit', { plan: { propertyId: f.notes, ...over } })
  return { h, f, text, conv, prev: (plan) => previewConversion(h.coord, { propertyId: f.notes, ...plan }, 'Asia/Tehran') }
}

test('F25 Persian digits and the Arabic decimal separator convert to a number', async () => {
  const { h, f, text, conv } = await setup()
  await text('T1', '۱۲٫۵')
  await text('T2', ' 7 ')
  await text('T3', '')
  await text('T4', '-3')
  await conv({ destinationKind: 'number', mapping: { decimalSeparator: '٫' } })
  assert.equal(h.state.prop(f.notes).kind, 'number')
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.value, 12.5)
  assert.equal(h.state.row('T2').ext.cells[f.notes].value.value, 7)
  assert.equal(h.state.row('T3').ext.cells[f.notes], undefined) // empty stays empty, never 0
  assert.equal(h.state.row('T4').ext.cells[f.notes].value.value, -3)
})

test('F26 "12abc" -> Number with rejectInvalid is rejected and the original stays intact', async () => {
  const { h, f, text, conv, prev } = await setup()
  await text('T1', '12abc')
  const p = prev({ destinationKind: 'number' })
  assert.equal(p.report.counts.invalid, 1)
  assert.match(p.report.invalid[0].reason, /not a number/)
  await assert.rejects(conv({ destinationKind: 'number' }), (e) => e.code === 'INVALID_VALUE')
  assert.equal(h.state.prop(f.notes).kind, 'text')
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.runs[0].text, '12abc')
  // clearInvalid converts the rest and archives the original
  await conv({ destinationKind: 'number', invalidPolicy: 'clearInvalid' })
  assert.equal(h.state.prop(f.notes).kind, 'number')
  assert.equal(h.state.row('T1').ext.cells[f.notes], undefined)
  assert.ok(Object.keys(h.state.row('T1').ext.archivedCells).length >= 1)
})

test('conversion is one undo group that restores kind, config and cells', async () => {
  const { h, f, text, conv } = await setup()
  await text('T1', '5')
  await conv({ destinationKind: 'number' })
  assert.equal(h.state.prop(f.notes).kind, 'number')
  const u = await h.coord.undo('U1')
  assert.equal(u.ok, true)
  assert.equal(h.state.prop(f.notes).kind, 'text')
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.runs[0].text, '5')
})

test('a changed row after the preview invalidates the preview hash', async () => {
  const { h, f, text, prev } = await setup()
  await text('T1', '5')
  const p = prev({ destinationKind: 'number' })
  await text('T2', '6')
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.notes, destinationKind: 'number' }, previewHash: p.previewHash }), (e) => e.code === 'SCHEMA_MISMATCH')
})

test('text -> checkbox, number <-> checkbox, strict', async () => {
  const { h, f, text, conv } = await setup()
  await text('T1', 'Yes'); await text('T2', 'no'); await text('T3', '1'); await text('T4', 'maybe')
  await assert.rejects(conv({ destinationKind: 'checkbox' }), (e) => e.code === 'INVALID_VALUE')
  await text('T4', 'false')
  await conv({ destinationKind: 'checkbox' })
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.value, true)
  assert.equal(h.state.row('T3').ext.cells[f.notes].value.value, true)
  assert.equal(h.state.row('T2').ext.cells[f.notes], undefined) // false is the default
  await h.one('property.convert_commit', { plan: { propertyId: f.notes, destinationKind: 'number' } })
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.value, 1)
  assert.equal(h.state.row('T2').ext.cells[f.notes].value.value, 0)
  await h.one('row.patch', { pageId: 'T2', cellChanges: { [f.notes]: { kind: 'number', value: 2 } } })
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.notes, destinationKind: 'checkbox' } }), (e) => e.code === 'INVALID_VALUE')
})

test('text -> date: strict ISO, explicit format, ambiguous slash dates are invalid', async () => {
  const { h, f, text, prev, conv } = await setup()
  await text('T1', '2026-10-25'); await text('T2', '01/02/03'); await text('T3', ''); await text('T4', '2026-10-25T09:00')
  const p = prev({ destinationKind: 'date' })
  assert.equal(p.report.counts.invalid, 1)
  await assert.rejects(conv({ destinationKind: 'date' }), (e) => e.code === 'INVALID_VALUE')
  assert.equal(h.state.prop(f.notes).kind, 'text')
  await text('T1', '25/10/2026'); await text('T2', '25/10/2026'); await text('T4', '01/01/2020')
  await conv({ destinationKind: 'date', mapping: { dateFormat: 'DD/MM/YYYY' } })
  assert.deepEqual(h.state.row('T2').ext.cells[f.notes].value.value, { kind: 'date', start: '2026-10-25', end: null })
  assert.equal(h.state.row('T3').ext.cells[f.notes], undefined)
})

test('date -> number only with an explicit timestamp unit and zone', async () => {
  const { h, f } = await setup()
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.due, destinationKind: 'number' } }), (e) => e.code === 'INVALID_VALUE')
  await h.one('property.convert_commit', { plan: { propertyId: f.due, destinationKind: 'number', mapping: { timestampUnit: 'ms', zone: 'Asia/Tehran' } } })
  assert.equal(h.state.row('T1').ext.cells[f.due].value.value, Date.parse('2026-10-24T20:30:00Z'))
})

test('text -> select needs an explicit mapping or permission to create options; ambiguous labels are errors', async () => {
  const { h, f, text, prev, conv } = await setup()
  await text('T1', 'red'); await text('T2', 'Blue'); await text('T3', 'purple'); await text('T4', '')
  const dest = { options: [{ id: 'o1', name: 'red', color: 'red', sortKey: 'V' }, { id: 'o2', name: 'blue', color: 'blue', sortKey: 'l' }] }
  const p = prev({ destinationKind: 'select', destinationConfig: dest })
  assert.equal(p.report.counts.invalid, 1) // purple
  await assert.rejects(conv({ destinationKind: 'select', destinationConfig: dest }), (e) => e.code === 'INVALID_VALUE')
  await conv({ destinationKind: 'select', destinationConfig: dest, mapping: { labels: { purple: 'create' } } })
  const opts = h.state.prop(f.notes).config.options
  assert.deepEqual(opts.map((o) => o.name), ['red', 'blue', 'purple'])
  assert.equal(h.state.row('T1').ext.cells[f.notes].value.optionId, 'o1')
  assert.equal(h.state.row('T2').ext.cells[f.notes].value.optionId, 'o2')
  assert.equal(h.state.row('T3').ext.cells[f.notes].value.optionId, opts[2].id)
})

test('ambiguous option labels are never first-matched', async () => {
  const { h, f, text } = await setup()
  await text('T1', 'x')
  const dup = { options: [{ id: 'a', name: 'X', color: 'red', sortKey: 'V' }, { id: 'b', name: 'x ', color: 'red', sortKey: 'l' }] }
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.notes, destinationKind: 'select', destinationConfig: dup } }))
  assert.equal(h.state.prop(f.notes).kind, 'text')
})

test('text -> multi-select never splits commas unless a delimiter is chosen', async () => {
  const { h, f, text, conv } = await setup()
  await text('T1', 'red, blue')
  const dest = { options: [{ id: 'o1', name: 'red', color: 'red', sortKey: 'V' }, { id: 'o2', name: 'blue', color: 'blue', sortKey: 'l' }, { id: 'o3', name: 'red, blue', color: 'red', sortKey: 'x' }] }
  await conv({ destinationKind: 'multi_select', destinationConfig: dest })
  assert.deepEqual(h.state.row('T1').ext.cells[f.notes].value.optionIds, ['o3'])
})

test('select <-> multi-select, status -> checkbox', async () => {
  const { h, f } = await setup()
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.tags, destinationKind: 'select' } }), (e) => e.code === 'INVALID_VALUE')
  await h.one('property.convert_commit', { plan: { propertyId: f.tags, destinationKind: 'select', mapping: { pick: 'first_by_order' } } })
  assert.equal(h.state.row('T1').ext.cells[f.tags].value.optionId, f.to('red'))
  await h.one('property.convert_commit', { plan: { propertyId: f.tags, destinationKind: 'multi_select' } })
  assert.deepEqual(h.state.row('T1').ext.cells[f.tags].value.optionIds, [f.to('red')])
  await h.one('property.convert_commit', { plan: { propertyId: f.status, destinationKind: 'checkbox' } })
  assert.equal(h.state.row('T3').ext.cells[f.status].value.value, true)
  assert.equal(h.state.row('T1').ext.cells[f.status], undefined)
})

test('unsupported pairs and Title are refused, not guessed', async () => {
  const { h, f } = await setup()
  assert.equal(isConvertible('title', 'text'), false)
  assert.equal(isConvertible('files', 'number'), false)
  assert.equal(isConvertible('formula', 'text'), false)
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.titleId, destinationKind: 'text' } }), (e) => e.code === 'UNSUPPORTED_CONVERSION')
  await assert.rejects(h.one('property.convert_commit', { plan: { propertyId: f.due, destinationKind: 'files' } }), (e) => e.code === 'UNSUPPORTED_CONVERSION')
})

test('formula materializes to values from one snapshot; errors reject by default', async () => {
  const { h, f } = await setup()
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'Dbl', kind: 'formula', config: { source: 'prop("Cost") * 2' } })
  await h.one('property.materialize', { propertyId: fx.propertyId })
  assert.equal(h.state.prop(fx.propertyId).kind, 'number')
  assert.equal(h.state.row('T2').ext.cells[fx.propertyId].value.value, 20)
  const bad = await h.one('property.create', { sourceId: f.sourceId, name: 'Bad', kind: 'formula', config: { source: '1 / prop("Cost")' } })
  await assert.rejects(h.one('property.materialize', { propertyId: bad.propertyId }), (e) => e.code === 'INVALID_VALUE')
  assert.equal(h.state.prop(bad.propertyId).kind, 'formula')
})

test('static -> formula archives old values; text -> relation needs explicit page mapping', async () => {
  const { h, f, text } = await setup()
  await text('T1', 'hello')
  await h.one('property.convert_commit', { plan: { propertyId: f.notes, destinationKind: 'formula', destinationConfig: { languageVersion: 1, source: '1+1', ast: null, resolvedRefs: {}, resultType: 'number' } } })
  assert.equal(h.state.prop(f.notes).kind, 'formula')
  assert.equal(h.state.row('T1').ext.cells[f.notes], undefined)
  const s2 = await setup()
  await s2.text('T1', 'P1'); await s2.text('T2', ''); await s2.text('T3', ''); await s2.text('T4', '')
  await assert.rejects(s2.h.one('property.convert_commit', { plan: { propertyId: s2.f.notes, destinationKind: 'relation', destinationConfig: { targetSourceId: s2.f.projSrc } } }), (e) => e.code === 'INVALID_VALUE')
  await s2.h.one('property.convert_commit', { plan: { propertyId: s2.f.notes, destinationKind: 'relation', destinationConfig: { targetSourceId: s2.f.projSrc }, mapping: { pages: { P1: s2.f.P1 } } } })
  assert.equal(s2.h.state.prop(s2.f.notes).kind, 'relation')
  const rel = s2.h.state.relationOf(s2.f.notes)
  assert.equal(s2.h.state.snapshot().edgesFrom.get(rel.id).get('T1')[0].toPageId, s2.f.P1)
})
