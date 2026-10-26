// CSV import/export and native bundle backup (handoff §27; F38, F39, S06-S08).
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, seedFixture, FIXTURE_CLOCK, FIXTURE_ZONE, MemoryPageHost, VAULT } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { parseCsv, writeCsv, exportCsv, exportMarkdown, planImport, worldOf, inferColumnKinds } = await import('../../../spike/tiptap/src/database/csv.ts')
const { buildBundle, validateBundle, remapIds } = await import('../../../spike/tiptap/src/database/backup2.ts')
const { Coordinator } = await import('../../../spike/tiptap/src/database/commands/index.ts')
const { DbState, MemoryPages } = await import('../../../spike/tiptap/src/database/state.ts')
const { MemoryStorage } = await import('../../../spike/tiptap/src/database/storage/memory.ts')
const { runQuery, makeQuery } = await import('../../../spike/tiptap/src/database/query/engine.ts')

test('CSV parsing: quotes, embedded delimiters and newlines, BOM, CRLF', () => {
  const t = '﻿a,b,c\r\n1,"x,y","line1\nline2"\r\n"q""uote",,\r\n'
  assert.deepEqual(parseCsv(t), [['a', 'b', 'c'], ['1', 'x,y', 'line1\nline2'], ['q"uote', '', '']])
  assert.deepEqual(parseCsv('a;b\n1;2', ';'), [['a', 'b'], ['1', '2']])
  assert.throws(() => parseCsv('a,"open'), (e) => e.code === 'INVALID_VALUE')
  assert.deepEqual(parseCsv(writeCsv([['a,b', 'c"d', 'e\nf']], { safe: false })), [['a,b', 'c"d', 'e\nf']])
})

test('CSV export guards spreadsheet formula injection unless raw export is chosen', () => {
  assert.match(writeCsv([['=SUM(A1)', '+1+2', '@cmd', '-5', 'ok']]), /'=SUM\(A1\),'\+1\+2,'@cmd,-5,ok/)
  assert.match(writeCsv([['=SUM(A1)']], { safe: false }), /^=SUM\(A1\)/)
})

test('export honours permissions and scope; relations as titles; markdown is readable interchange', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const csv = exportCsv(h.state, { sourceId: f.sourceId, principalId: 'U1', now: FIXTURE_CLOCK, zone: FIXTURE_ZONE })
  const rows = parseCsv(csv)
  assert.deepEqual(rows[0], ['Name', 'Status', 'Cost', 'Due', 'Tags', 'Done', 'Notes', 'Project'])
  assert.deepEqual(rows[1], ['T1', 'todo', '0', '2026-10-25', 'red, blue', 'false', '', 'P1'])
  assert.deepEqual(rows[3], ['T3', 'done', '', '', '', 'false', 'alpha', 'P2'])
  const md = exportMarkdown(h.state, { sourceId: f.sourceId, principalId: 'U1', now: FIXTURE_CLOCK, zone: FIXTURE_ZONE, propertyIds: [f.titleId, f.cost] })
  assert.match(md, /\| Name \| Cost \|\n\| --- \| --- \|\n\| T1 \| 0 \|/)
  // a restricted column disappears from the export entirely
  await h.one('record.put', { kind: 'principal', id: 'U2', body: { type: 'user', displayName: 'G', email: null, memberIds: [], isLocalOwner: false, externalId: null } })
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U2', containerId: null, sourceId: f.sourceId, pageId: null, right: 'view', propertyId: null, propertyRights: null, viaPropertyId: null } })
  await h.one('record.put', { kind: 'grant', body: { principalId: 'U1', containerId: null, sourceId: f.sourceId, pageId: null, right: 'full', propertyId: f.cost, propertyRights: { seeDefinition: true, readValues: true, editValues: true, editDefinition: true }, viaPropertyId: null } })
  const guest = parseCsv(exportCsv(h.state, { sourceId: f.sourceId, principalId: 'U2', now: FIXTURE_CLOCK, zone: FIXTURE_ZONE }))
  assert.equal(guest[0].includes('Cost'), false)
})

function importPayload(f, over = {}) {
  const data = [['Name', 'Cost', 'Done', 'Due'], ['A', '1.5', 'yes', '2026-11-01'], ['B', '', 'no', ''], ['C', '۱۲٫۵', 'true', '2026-11-02']]
  return {
    data,
    options: {
      sourceId: f.sourceId, sessionId: 'sess-1', hasHeader: true, decimalSeparator: '.',
      columns: [{ column: 0, target: 'title' }, { column: 1, target: f.cost }, { column: 2, target: f.done }, { column: 3, target: f.due }],
      ...over,
    },
  }
}

test('F39 CSV append: a second session adds rows again, a retried session adds nothing', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const n0 = h.state.rows(f.sourceId).length
  const a = await h.one('csv.import', importPayload(f))
  assert.equal(a.created, 3)
  assert.equal(h.state.rows(f.sourceId).length, n0 + 3)
  const retry = await h.run([{ type: 'csv.import', payload: importPayload(f) }]) // new operation id, same session
  assert.equal(retry.result.repeated, true)
  assert.equal(h.state.rows(f.sourceId).length, n0 + 3)
  const again = await h.one('csv.import', importPayload(f, { sessionId: 'sess-2' }))
  assert.equal(again.created, 3)
  assert.equal(h.state.rows(f.sourceId).length, n0 + 6) // same data in a separate session: append, never title dedupe
  const rowC = h.state.rows(f.sourceId).find((r) => r.page.title === 'C')
  assert.equal(rowC.ext.cells[f.cost].value.value, 12.5)
  assert.equal(rowC.ext.cells[f.done].value.value, true)
})

test('import is atomic: one bad cell rejects the file and reports row and column', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const n0 = h.state.rows(f.sourceId).length
  const bad = importPayload(f)
  bad.data[2][1] = '12abc'
  await assert.rejects(h.one('csv.import', bad), (e) => e.code === 'INVALID_VALUE' && e.detail.problems[0].row === 3 && e.detail.problems[0].column === 1)
  assert.equal(h.state.rows(f.sourceId).length, n0)
  const ok = await h.one('csv.import', { ...bad, options: { ...bad.options, skipInvalid: true, sessionId: 'sess-skip' } })
  assert.equal(ok.created, 3)
  assert.equal(ok.problems, 1)
})

test('import: formulas are never executed from text, relation labels need explicit mapping, ids first', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const fx = await h.one('property.create', { sourceId: f.sourceId, name: 'Calc', kind: 'formula', config: { source: '1+1' } })
  await assert.rejects(h.one('csv.import', { data: [['x'], ['=1+1']], options: { sourceId: f.sourceId, sessionId: 's', hasHeader: true, columns: [{ column: 0, target: fx.propertyId }] } }), (e) => e.code === 'UNSUPPORTED_CONVERSION')
  const rel = { sourceId: f.sourceId, hasHeader: true, columns: [{ column: 0, target: 'title' }, { column: 1, target: f.project }] }
  await assert.rejects(h.one('csv.import', { data: [['n', 'h'], ['R1', 'Alpha']], options: { ...rel, sessionId: 'r1' } }), (e) => e.detail.problems[0].message.includes('not mapped'))
  const ok = await h.one('csv.import', { data: [['n', 'h'], ['R1', 'Alpha'], ['R2', f.P2]], options: { ...rel, sessionId: 'r2', relationLabels: { [f.project]: { Alpha: f.P1 } } } })
  assert.equal(ok.created, 2)
  const r1 = h.state.rows(f.sourceId).find((r) => r.page.title === 'R1')
  assert.equal(h.state.edgesOut(f.projectRelation, r1.page.id)[0].toPageId, f.P1)
})

test('import can create select options when allowed, and explicit upsert by page id is a labeled extension', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const cols = [{ column: 0, target: 'page_id' }, { column: 1, target: 'title' }, { column: 2, target: f.status }]
  await assert.rejects(h.one('csv.import', { data: [['id', 'n', 's'], ['', 'N1', 'blocked']], options: { sourceId: f.sourceId, sessionId: 'o1', hasHeader: true, columns: cols } }), (e) => e.code === 'INVALID_VALUE')
  const r = await h.one('csv.import', { data: [['id', 'n', 's'], ['', 'N1', 'blocked'], ['T1', 'T1 renamed', 'doing']], options: { sourceId: f.sourceId, sessionId: 'o2', hasHeader: true, columns: cols, createOptions: true, upsertBy: 'page_id' } })
  assert.equal(r.created, 1)
  assert.equal(r.updated, 1)
  assert.equal(h.state.row('T1').page.title, 'T1 renamed')
  assert.ok(h.state.prop(f.status).config.options.some((o) => o.name === 'blocked'))
  assert.equal(h.state.rows(f.sourceId).length, 5)
})

test('type inference for the preview never applies itself', () => {
  const kinds = inferColumnKinds([['a', '1', 'yes', '2026-01-01'], ['b', '2,5', 'no', '2026-02-02']], 4)
  assert.deepEqual(kinds.map((k) => k.kind), ['text', 'number', 'checkbox', 'date'])
  const world = { props: () => [], row: () => undefined, relationOf: () => undefined, titlesIn: () => [] }
  assert.deepEqual(planImport(world, [['x']], { sourceId: 's', sessionId: 'z', hasHeader: true, columns: [] }).rows, [])
  void worldOf
})

// ───── bundle ─────

async function restoreInto(src, mode = 'replace') {
  const pages = new MemoryPages()
  const storage = new MemoryStorage(pages)
  const state = new DbState(VAULT, pages)
  const coord = new Coordinator({ state, storage, pageHost: new MemoryPageHost(pages), deviceId: 'D2', ids: (() => { let n = 0; return () => `r${++n}` })() })
  await coord.open()
  for (const p of src.pages.all()) pages.put(structuredClone(p)) // pages come back through the page restore (v1 envelope)
  const bundle = JSON.parse(JSON.stringify(buildBundle(src.state)))
  const envl = (commands) => ({ operationId: `rs-${mode}`, vaultId: VAULT, actorId: 'U1', deviceId: 'D2', expected: [], origin: 'user', commands })
  await coord.execute(envl([{ type: 'principal.ensure_owner', payload: {} }]))
  const res = await coord.execute({ ...envl([{ type: 'backup.restore', payload: { bundle, expectedManifestHash: bundle.manifestHash, mode, pageIds: src.pages.all().map((p) => p.id) } }]), operationId: `bk-${mode}` })
  return { state, pages, coord, bundle, res }
}

test('F38 backup v2 restore into an empty vault: counts, values, canonical edge ids and view config are equal', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  await h.one('view.patch', { viewId: f.viewId, filter: { kind: 'predicate', propertyId: f.done, op: 'equals', operand: false }, configurationPatch: { wrap: true } })
  const r = await restoreInto(h)
  for (const kind of ['container', 'source', 'property', 'view', 'relation', 'edge']) assert.equal(r.state.all(kind).length, h.state.all(kind).length, kind)
  assert.deepEqual(r.state.all('edge').map((e) => e.id).sort(), h.state.all('edge').map((e) => e.id).sort())
  assert.deepEqual(r.state.get('view', f.viewId).configuration, h.state.get('view', f.viewId).configuration)
  assert.deepEqual(r.state.get('view', f.viewId).filter, h.state.get('view', f.viewId).filter)
  const q = (st) => runQuery(st, makeQuery(st, f.sourceId, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, { sorts: [{ propertyId: f.cost, direction: 'asc' }], projection: [f.cost, f.tags, f.status] })).rows.map((x) => JSON.stringify([x.pageId, x.values]))
  assert.deepEqual(q(r.state), q(h.state))
})

test('restore validates everything first: corrupt manifest, missing reference, duplicate id change nothing', async () => {
  const h = createHarness()
  await seedFixture(h)
  const good = JSON.parse(JSON.stringify(buildBundle(h.state)))
  assert.deepEqual(validateBundle(good), [])
  const tampered = JSON.parse(JSON.stringify(good)); tampered.records.property[0].name = 'hacked'
  assert.ok(validateBundle(tampered).some((p) => p.code === 'HASH'))
  const dup = JSON.parse(JSON.stringify(good)); dup.records.view.push(dup.records.view[0])
  assert.ok(validateBundle(dup).some((p) => p.code === 'DUPLICATE'))
  const missing = JSON.parse(JSON.stringify(good)); missing.records.property[0].sourceId = 'nope'
  assert.ok(validateBundle(missing).some((p) => p.code === 'REFERENCE'))
  assert.equal(validateBundle({ format: 'notes-backup', version: 1 })[0].code, 'FORMAT')
  const before = JSON.stringify(h.state.all('property'))
  await assert.rejects(h.one('backup.restore', { bundle: tampered, expectedManifestHash: tampered.manifestHash, mode: 'replace' }), (e) => e.code === 'INVALID_VALUE')
  assert.equal(JSON.stringify(h.state.all('property')), before)
})

test('replace never rolls back current grants; merge remaps colliding ids consistently', async () => {
  const h = createHarness()
  const f = await seedFixture(h)
  const bundle = JSON.parse(JSON.stringify(buildBundle(h.state)))
  await h.one('record.put', { kind: 'principal', id: 'U7', body: { type: 'user', displayName: 'New', email: null, memberIds: [], isLocalOwner: false, externalId: null } })
  await h.one('record.put', { kind: 'grant', id: 'G7', body: { principalId: 'U7', containerId: null, sourceId: f.sourceId, pageId: null, right: 'view', propertyId: null, propertyRights: null, viaPropertyId: null } })
  await h.one('row.patch', { pageId: 'T1', title: 'later edit' })
  await h.one('backup.restore', { bundle, expectedManifestHash: bundle.manifestHash, mode: 'replace' })
  assert.ok(h.state.get('grant', 'G7'), 'current grants survive the restore')
  assert.ok(h.state.get('principal', 'U7'))
  // merge into the same vault: every id collides -> everything is remapped, references stay intact
  const before = h.state.all('property').length
  await h.one('backup.restore', { bundle, expectedManifestHash: bundle.manifestHash, mode: 'merge' }, { operationId: 'merge-1' })
  assert.ok(h.state.all('property').length > before)
  const newSource = h.state.all('source').find((s) => !bundle.records.source.some((b) => b.id === s.id))
  assert.ok(newSource)
  const props = h.state.all('property').filter((p) => p.sourceId === newSource.id)
  assert.ok(props.length >= 1)
  const nc = h.state.all('container').find((c) => c.id === newSource.ownerContainerId)
  assert.ok(nc && !bundle.records.container.some((b) => b.id === nc.id))
  assert.equal(h.state.get('property', newSource.titlePropertyId).sourceId, newSource.id)
  assert.deepEqual(remapIds({ a: 'x', x: ['x', { x: 1 }] }, new Map([['x', 'y']])), { a: 'y', y: ['y', { y: 1 }] })
})
