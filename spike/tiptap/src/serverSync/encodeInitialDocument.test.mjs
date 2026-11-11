import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { Schema } from '@tiptap/pm/model'
import * as Y from 'yjs'
import { encodeInitialDocument, initializationFingerprint, prepareInitialDocument, readInitialDocument } from './encodeInitialDocument.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+', attrs: { blockIdentityVersion: { default: 0 } } },
    paragraph: { group: 'block', content: 'inline*', attrs: { blockId: { default: null }, dir: { default: null } } },
    custom: { group: 'block', atom: true, attrs: { blockId: {}, payload: {} } },
    text: { group: 'inline' },
  },
  marks: { bold: {} },
})
const content = { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [
  { type: 'paragraph', attrs: { blockId: 'p1', dir: 'rtl' }, content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'سلام' }] },
  { type: 'custom', attrs: { blockId: 'b2', payload: { x: 2, values: ['a', 'b'] } } },
] }
const page = { id: 'p', parentId: null, title: 'Test', favorite: false, sort: 0, content, updatedAt: 1, deletedAt: null }
const scope = { vaultId: 'v', accountId: 'a', collaborationOrigin: 'https://sync.example', documentId: 'p' }

test('Yjs update preserves root and custom node attributes, RTL, and marks', () => {
  const update = encodeInitialDocument(schema, page)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  assert.deepEqual(JSON.parse(JSON.stringify(readInitialDocument(doc, schema))), content)
  assert.equal(doc.getXmlFragment('default').length, 2)
  doc.destroy()
})

test('unknown or lossy content is rejected before persistence', () => {
  assert.throws(() => encodeInitialDocument(schema, { ...page, content: '<p>legacy</p>' }), /requires conversion/)
  assert.throws(() => encodeInitialDocument(schema, { ...page, content: { ...content, content: [{ type: 'unknown' }] } }), /unsupported/)
  const noRootAttrs = { ...content }; delete noRootAttrs.attrs
  assert.throws(() => encodeInitialDocument(schema, { ...page, content: noRootAttrs }), /would change/)
})

test('preparation reuses saved bytes without generating a new Yjs identity', async () => {
  let saved = null, writes = 0
  const store = {
    load: async () => saved,
    prepare: async (_scope, bytes, expectedPage) => { assert.deepEqual(expectedPage, page); writes++; saved = bytes; return bytes },
  }
  const first = await prepareInitialDocument(schema, page, scope, store)
  const second = await prepareInitialDocument(schema, page, scope, store)
  assert.deepEqual(first, second)
  assert.equal(writes, 2) // retry rechecks the saved page
  assert.equal(await initializationFingerprint(first), createHash('sha256').update(first).digest('hex'))
  assert.equal(await initializationFingerprint(second), await initializationFingerprint(first))
  await assert.rejects(prepareInitialDocument(schema, page, { ...scope, documentId: 'other' }, store), /mismatch/)
})
