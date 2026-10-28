import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import { planDocumentEdit, DocumentPlanError } from '../spike/tiptap/src/documents/editPlanner.ts'
import { documentRevision } from '../spike/tiptap/src/documents/revision.ts'
import { documentToolContracts, LIMITS } from '../spike/tiptap/src/documents/contracts.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'

const digest = async value => createHash('sha256').update(value).digest('hex')
const runtime = { digest, canLink: id => id === 'allowed-note' }
const ref = blockId => ({ blockId }), temp = temporaryId => ({ temporaryId })
const range = (from, through = from) => ({ from: ref(from), through: ref(through) })
const text = value => ({ type: 'text', text: value })
const block = (type, id, content = [], attrs = {}) => ({ type, attrs: { blockId: id, ...attrs }, content })
const para = (id, value = 'متن فارسی ZWNJ نیم‌فاصله') => block('paragraph', id, [text(value)], { dir: 'rtl', textAlign: 'right' })
const page = (content = [para('p1')]) => ({ id: 'note', parentId: null, title: 'عنوان', tags: ['original'], icon: undefined,
  favorite: false, sort: 1, updatedAt: 42, deletedAt: null, content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content } })
const input = async (source, operations, extra = {}) => ({ documentId: source.id, expectedRevision: await documentRevision(source, digest), operationId: 'plan-once', mode: 'preview', operations, ...extra })
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze) } return value }
const output = new Ajv({ strict: true }).compile(documentToolContracts.edit_document.outputSchema)

test('all six operations resolve progressively, preserve RTL/custom/layout/table data, and preview never saves', async () => {
  const opaque = block('futureWidget', 'opaque', [], { blob: { untouched: ['RTL', 'فارسی', '\u200c'] } })
  const table = block('table', 'table', [block('tableRow', 'row', [block('tableCell', 'cell', [para('cell-text')], { colspan: 1, rowspan: 1 })])], { dir: 'rtl' })
  const drawing = block('drawing', 'drawing', [], { scene: 'keep-original', preview: 'attachment-id' })
  const linked = para('raw-link'); linked.content[0].marks = [{ type: 'link', attrs: { href: 'https://example.invalid', target: '_blank' } }]
  const layout = block('layoutGroup', 'layout', [block('layoutColumn', 'col1', [para('col1-text')]), block('layoutColumn', 'col2', [para('col2-text')])], { direction: 'rtl', widths: [35, 65] })
  const source = freeze(page([block('heading', 'heading', [text('section')], { level: 1, dir: 'rtl' }), para('p1'),
    block('heading', 'next-heading', [text('Keep next section')], { level: 1 }), para('next-section'),
    block('blockquote', 'quote', [para('quote-text')]), opaque, table, drawing, linked, layout]))
  const store = new MemoryDocumentStorage('fixed', [source]), snapshot = structuredClone(source)
  const operations = [
    { kind: 'insert_blocks', at: { position: 'after', target: ref('p1') }, blocks: [{ temporaryId: 'inserted', node: { type: 'paragraph', content: [text('new')] } }] },
    { kind: 'set_attributes', target: temp('inserted'), attributes: { dir: 'rtl' } },
    { kind: 'move_blocks', target: { from: temp('inserted'), through: temp('inserted') }, at: { position: 'end', parent: ref('quote') } },
    { kind: 'set_internal_link', target: temp('inserted'), destinationDocumentId: 'allowed-note', label: 'پیوند' },
    { kind: 'replace_blocks', target: range('p1'), blocks: [{ temporaryId: 'replacement', node: { type: 'paragraph', content: [{ ...text('replacement'), marks: [{ type: 'bold' }] }] } }] },
    { kind: 'delete_blocks', target: range('heading') },
    { kind: 'insert_blocks', at: { position: 'end', parent: ref('col2') }, blocks: [{ temporaryId: 'column-new', node: { type: 'heading', attrs: { level: 2 }, content: [text('ستون')] } }] },
    { kind: 'set_attributes', target: temp('column-new'), attributes: { level: 3 } },
  ]
  const request = freeze(await input(source, operations)), plan = await planDocumentEdit(source, request, runtime)
  assert.deepEqual(source, snapshot)
  assert.deepEqual(await store.load(), [snapshot])
  assert.equal(plan.preview.persisted, false)
  assert.ok(output({ ok: true, result: plan.preview }), JSON.stringify(output.errors))
  assert.deepEqual({ ...plan.after, content: null }, { ...snapshot, content: null })
  const nodes = plan.after.content.content
  for (const original of [opaque, table, drawing, linked]) assert.deepEqual(nodes.find(node => node.attrs.blockId === original.attrs.blockId), original)
  assert.deepEqual(nodes.find(node => node.attrs.blockId === 'next-heading'), snapshot.content.content[2])
  assert.deepEqual(nodes.find(node => node.attrs.blockId === 'next-section'), snapshot.content.content[3])
  const moved = nodes.find(node => node.type === 'blockquote').content[1]
  assert.equal(moved.attrs.blockId, plan.temporaryIds.inserted)
  assert.equal(moved.attrs.dir, 'rtl')
  assert.deepEqual(moved.content, [{ type: 'pageLink', attrs: { id: 'allowed-note', label: 'پیوند' } }])
  const editedLayout = nodes.find(node => node.type === 'layoutGroup')
  assert.deepEqual(editedLayout.attrs, layout.attrs)
  assert.deepEqual(editedLayout.content[0], layout.content[0])
  assert.equal(editedLayout.content[1].content[1].attrs.level, 3)
  assert.equal(JSON.parse(plan.preview.changes[2].before).location.parentBlockId, null)
  assert.equal(JSON.parse(plan.preview.changes[2].after).location.parentBlockId, 'quote')
  const apply = await planDocumentEdit(source, { ...request, mode: 'apply', budget: { maxChars: 1, maxBlocks: 1 } }, runtime)
  assert.deepEqual(apply.after, plan.after)
  assert.deepEqual(apply.temporaryIds, plan.temporaryIds)
  assert.equal(apply.preview.truncated, true)
})

test('invalid batches are atomic: schema, scope, identities, sibling ranges, cycles and protected descendants', async () => {
  const source = freeze(page([para('p1'), block('blockquote', 'quote', [para('q1')]),
    block('futureWidget', 'opaque', [para('opaque-child')]), block('table', 'table', [block('tableRow', 'row', [block('tableCell', 'cell', [para('cell-text')])])])]))
  const snapshot = structuredClone(source)
  const insert = { kind: 'insert_blocks', at: { position: 'end', parent: null }, blocks: [{ temporaryId: 'new', node: { type: 'paragraph' } }] }
  const cases = [
    [{ kind: 'delete_blocks', target: range('p1', 'q1') }, 'INVALID_TARGET'],
    [{ kind: 'move_blocks', target: range('quote'), at: { position: 'end', parent: ref('quote') } }, 'INVALID_TARGET'],
    [{ kind: 'move_blocks', target: range('quote'), at: { position: 'before', target: ref('q1') } }, 'INVALID_TARGET'],
    [{ kind: 'set_attributes', target: ref('cell-text'), attributes: { dir: 'ltr' } }, 'UNSUPPORTED_CONTENT'],
    [{ kind: 'set_attributes', target: ref('opaque-child'), attributes: { dir: 'ltr' } }, 'UNSUPPORTED_CONTENT'],
    [{ kind: 'delete_blocks', target: range('opaque') }, 'UNSUPPORTED_CONTENT'],
    [{ kind: 'set_attributes', target: ref('p1'), attributes: { level: 4 } }, 'UNSUPPORTED_CONTENT'],
    [{ kind: 'set_attributes', target: ref('p1'), attributes: { blockId: 'forged' } }, 'INVALID_ARGUMENT'],
    [{ kind: 'set_attributes', target: temp('not-yet-created'), attributes: { dir: 'ltr' } }, 'INVALID_TARGET'],
    [{ kind: 'set_internal_link', target: ref('p1'), destinationDocumentId: 'hidden', label: 'secret' }, 'ACCESS_DENIED'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'paragraph', attrs: { blockId: 'forged' } } }] }, 'INVALID_ARGUMENT'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: 'hidden', label: 'hidden' } }] } }] }, 'ACCESS_DENIED'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'bulletList', content: [{ type: 'paragraph' }] } }] }, 'UNSUPPORTED_CONTENT'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'paragraph', content: [{ ...text('code'), marks: [{ type: 'code' }, { type: 'bold' }] }] } }] }, 'UNSUPPORTED_CONTENT'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'futureWidget' } }] }, 'UNSUPPORTED_CONTENT'],
    [{ ...insert, blocks: [{ temporaryId: 'new2', node: { type: 'heading', attrs: { level: 7 } } }] }, 'INVALID_ARGUMENT'],
    [{ ...insert, blocks: [{ temporaryId: 'new', node: { type: 'paragraph' } }] }, 'INVALID_ARGUMENT'],
    [{ kind: 'delete_blocks', target: range('q1') }, 'UNSUPPORTED_CONTENT'], // leaves an empty quote in final document
  ]
  for (const [operation, code] of cases) {
    const request = await input(source, [insert, operation])
    await assert.rejects(planDocumentEdit(source, request, runtime), error => error instanceof DocumentPlanError && error.code === code)
    assert.deepEqual(source, snapshot)
  }
  const stale = await input(source, [insert]); stale.expectedRevision = 'r1:stale'
  await assert.rejects(planDocumentEdit(source, stale, runtime), { code: 'REVISION_CONFLICT' })
  const duplicated = structuredClone(source); duplicated.content.content[1].attrs.blockId = 'p1'
  await assert.rejects(planDocumentEdit(duplicated, await input(duplicated, [insert]), runtime), { code: 'CAPABILITY_UNAVAILABLE' })
  const reuseDeleted = await input(source, [insert, { kind: 'delete_blocks', target: { from: temp('new'), through: temp('new') } }, { kind: 'set_attributes', target: temp('new'), attributes: { dir: 'ltr' } }])
  await assert.rejects(planDocumentEdit(source, reuseDeleted, runtime), { code: 'INVALID_TARGET' })
  for (const unavailable of [{ ...source, kind: 'folder' }, { ...source, deletedAt: 1 }, { ...source, content: '<p>legacy</p>' }]) {
    await assert.rejects(planDocumentEdit(unavailable, await input(unavailable, [insert]), runtime), { code: 'CAPABILITY_UNAVAILABLE' })
  }
  const invalid = await input(source, [insert]); invalid.grantId = 'forged'
  await assert.rejects(planDocumentEdit(source, invalid, runtime), { code: 'INVALID_ARGUMENT' })
})

test('bounded deterministic previews remain wire-valid and edited standard content passes the actual StarterKit schema', async () => {
  const source = page([block('paragraph', 'p'.repeat(128), [text('🙂'.repeat(5000))])])
  const operations = Array.from({ length: 100 }, (_, i) => ({ kind: 'set_attributes', target: ref('p'.repeat(128)), attributes: { dir: i % 2 ? 'rtl' : 'ltr' } }))
  const request = await input(source, operations)
  const plan = await planDocumentEdit(source, request, runtime)
  assert.equal(plan.preview.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: plan.preview })) <= LIMITS.responseBytes)
  assert.ok(output({ ok: true, result: plan.preview }), JSON.stringify(output.errors))
  const require = createRequire(new URL('../spike/tiptap/package.json', import.meta.url))
  const { getSchema } = require('@tiptap/core'), { StarterKit } = require('@tiptap/starter-kit')
  const schema = getSchema([StarterKit])
  schema.nodeFromJSON(plan.after.content).check()
  const plain = page([para('p1'), para('p2')])
  const listPlan = await planDocumentEdit(plain, await input(plain, [{ kind: 'replace_blocks', target: range('p1', 'p2'), blocks: [{ temporaryId: 'list', node: { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('item')] }, { type: 'codeBlock', attrs: { language: 'javascript' }, content: [text('let x = 1')] }] }] } }] }]), runtime)
  schema.nodeFromJSON(listPlan.after.content).check()
  assert.equal(listPlan.after.content.content[0].content[0].content[1].attrs.language, 'javascript')
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const copiedInput = await input(plain, [{ kind: 'set_attributes', target: ref('p1'), attributes: { dir: 'ltr' } }])
  const pending = planDocumentEdit(plain, copiedInput, { ...runtime, digest: async value => { await waiting; return digest(value) } })
  copiedInput.operations[0].attributes.dir = 'rtl'; plain.content.content[0].content[0].text = 'intervening caller mutation'
  release()
  const detached = await pending
  assert.equal(detached.after.content.content[0].attrs.dir, 'ltr')
  assert.notEqual(detached.before.content.content[0].content[0].text, 'intervening caller mutation')
  await assert.rejects(planDocumentEdit(source, { ...request, operations: [...operations, operations[0]] }, runtime), { code: 'LIMIT_EXCEEDED' })
  await assert.rejects(planDocumentEdit(source, request, { ...runtime, digest: async () => { throw new Error('unavailable') } }), error => error.code === 'APP_UNAVAILABLE' && error.retryable)
})
