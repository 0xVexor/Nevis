import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planDocumentEdit } from '../spike/tiptap/src/documents/editPlanner.ts'
import { documentRevision } from '../spike/tiptap/src/documents/revision.ts'
import { tableGrid } from '../spike/tiptap/src/documents/tableEdits.ts'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
const digest = async text => createHash('sha256').update(text).digest('hex')
const n = (type, id, content, attrs = {}) => ({ type, attrs: { blockId: id, ...attrs }, ...(content ? { content } : {}) })
const p = (id, text = 'فارسی Java') => n('paragraph', id, [{ type: 'text', text }], { dir: 'rtl' })
const cell = (id, attrs = {}) => n('tableCell', id, [p(id + '-p')], { colspan: 1, rowspan: 1, ...attrs })
const source = () => ({ id: 'note', parentId: null, title: 'table', tags: [], favorite: false, sort: 0, updatedAt: 1, deletedAt: null,
 content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [p('before'), n('table', 'table', [n('tableRow', 'r1', [cell('a', { rowspan: 2, colwidth: [140] }), cell('b', { colspan: 2, colwidth: [100, 120] })]), n('tableRow', 'r2', [cell('c'), cell('d')])]), p('after')] } })
const ref = blockId => ({ blockId })
const blocks = id => [{ temporaryId: id, node: { type: 'paragraph', attrs: { dir: 'ltr' }, content: [{ type: 'text', text: 'English فارسی updated' }] } }]
const request = async (page, operations, mode = 'apply') => ({ documentId: page.id, operationId: 'table-op', expectedRevision: await documentRevision(page, digest), mode, operations })
const runtime = { digest, canLink: () => true }

test('cell edits preserve merged spans, mixed direction, surrounding nodes and deterministic preview/apply identities', async () => {
 const page = source(), original = structuredClone(page)
 const input = await request(page, [{ kind: 'set_table_cell', table: ref('table'), cell: ref('b'), blocks: blocks('replacement') }])
 const preview = await planDocumentEdit(page, { ...input, mode: 'preview' }, runtime), apply = await planDocumentEdit(page, input, runtime)
 assert.deepEqual(preview.after, apply.after); assert.deepEqual(page, original)
 const beforeTable = page.content.content[1], table = apply.after.content.content[1]
 assert.deepEqual(table.content[0].content[0], beforeTable.content[0].content[0]); assert.deepEqual(table.content[1], beforeTable.content[1])
 assert.deepEqual(table.content[0].content[1].attrs, beforeTable.content[0].content[1].attrs)
 assert.deepEqual(apply.after.content.content[0], page.content.content[0]); assert.deepEqual(apply.after.content.content[2], page.content.content[2])
 assert.equal(table.content[0].content[1].content[0].attrs.dir, 'ltr'); assert.equal(tableGrid(table).width, 3)
})

test('row insertion extends crossing vertical spans and preserves horizontal merges and neighbors', async () => {
 const page = source(), input = await request(page, [{ kind: 'insert_table_row', table: ref('table'), row: ref('r1'), position: 'after', cells: [{ kind: 'header', blocks: blocks('x') }, { kind: 'cell', blocks: blocks('y') }] }])
 const plan = await planDocumentEdit(page, input, runtime), table = plan.after.content.content[1]
 assert.equal(table.content.length, 3); assert.equal(table.content[0].content[0].attrs.rowspan, 3)
 assert.deepEqual(table.content[0].content[1], page.content.content[1].content[0].content[1]); assert.deepEqual(table.content[2], page.content.content[1].content[1])
 assert.equal(table.content[1].content[0].type, 'tableHeader'); assert.equal(tableGrid(table).width, 3)
})

test('wrong-table references, malformed spans and invalid row widths fail without partial saves', async () => {
 const page = source(), original = structuredClone(page)
 const bad = [
  { kind: 'set_table_cell', table: ref('table'), cell: ref('after'), blocks: blocks('x') },
  { kind: 'insert_table_row', table: ref('table'), row: ref('r1'), position: 'after', cells: [{ kind: 'cell', blocks: blocks('x') }] },
 ]
 for (const operation of bad) await assert.rejects(planDocumentEdit(page, await request(page, [operation]), runtime), error => ['INVALID_TARGET', 'UNSUPPORTED_CONTENT'].includes(error.code))
 const malformed = structuredClone(page); malformed.content.content[1].content[0].content[0].attrs.rowspan = 5
 await assert.rejects(planDocumentEdit(malformed, await request(malformed, [{ kind: 'set_table_cell', table: ref('table'), cell: ref('b'), blocks: blocks('x') }]), runtime), { code: 'UNSUPPORTED_CONTENT' })
 assert.deepEqual(page, original)
})

test('table commit, duplicate retry and undo use the existing durable receipt and full original snapshot', async () => {
 const page = source(), storage = new MemoryDocumentStorage('fixed', [page])
 const service = new DocumentService({ storage, host: { now: () => 100, createId: () => 'new', defer: () => () => {}, emit() {}, report() {}, syncState: () => 'disabled' } }); await service.init()
 const editor = service.editor({ context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => true, canRead: () => true, canWrite: () => true }, { digest })
 const input = await request(page, [{ kind: 'set_table_cell', table: ref('table'), cell: ref('b'), blocks: blocks('x') }])
 const result = await editor.editDocument(input); assert.equal(result.saved.replayed, false)
 assert.equal((await editor.editDocument(input)).saved.replayed, true)
 await editor.undoDocumentEdit({ documentId: 'note', operationId: 'undo-table', undoOperationId: input.operationId, expectedRevision: result.saved.revision })
 assert.deepEqual((await storage.load())[0].content, page.content)
})
