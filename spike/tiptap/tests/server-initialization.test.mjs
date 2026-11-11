import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { spawnSync } from 'node:child_process'
import { getSchema } from '@tiptap/core'
import { encodeInitialDocument, readInitialDocument } from '../src/serverSync/encodeInitialDocument.ts'

// The extension registry references these browser values while it is imported;
// this test constructs only the schema and does not mount an editor.
globalThis.window = globalThis
globalThis.document = { documentElement: { dataset: {}, style: {} }, body: {}, createElement: () => ({ style: {} }) }
globalThis.getComputedStyle = () => ({ colorScheme: 'light' })
globalThis.MutationObserver = class { observe() {} }

test('actual editor schema survives Yjs initialization with custom blocks', async () => {
  const { extensions } = await import('../src/editor/extensions.ts')
  const schema = getSchema(extensions)
  const doc = schema.nodeFromJSON({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [
    { type: 'paragraph', attrs: { blockId: 'p1', dir: 'rtl' }, content: [{ type: 'text', text: 'سلام', marks: [{ type: 'bold' }] }] },
    { type: 'callout', attrs: { blockId: 'c1', emoji: 'info' }, content: [
      { type: 'paragraph', attrs: { blockId: 'p2' }, content: [{ type: 'text', text: 'یادداشت' }] },
    ] },
    { type: 'drawing', attrs: { blockId: 'd1', scene: 'abc123', preview: 'def456' } },
  ] })
  doc.check()
  const content = doc.toJSON()
  const page = { id: 'p', parentId: null, title: 'test', favorite: false, sort: 0, content, updatedAt: 1, deletedAt: null }
  const bytes = encodeInitialDocument(schema, page)
  const restored = new Y.Doc()
  try {
    Y.applyUpdate(restored, bytes)
    assert.deepEqual(readInitialDocument(restored, schema), content)
  } finally { restored.destroy() }
})

test('server projects the desktop Yjs update', { skip: !process.env.NEVIS_COLLABORATION_DIR }, async () => {
  const { extensions } = await import('../src/editor/extensions.ts')
  const schema = getSchema(extensions)
  const hash = 'a'.repeat(64)
  const content = schema.nodeFromJSON({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [
    { type: 'paragraph', attrs: { blockId: 'p1', dir: 'rtl' }, content: [{ type: 'text', text: 'سلام', marks: [{ type: 'bold' }] }] },
    { type: 'image', attrs: { blockId: 'i1', src: `att:${hash}` } },
  ] }).toJSON()
  const page = { id: 'p', parentId: null, title: 'test', favorite: false, sort: 0, content, updatedAt: 1, deletedAt: null }
  const update = encodeInitialDocument(schema, page)
  const program = `import * as Y from 'yjs'; import {publicProjection} from './src/store.mjs';
    let data=''; for await (const chunk of process.stdin) data += chunk;
    const {update,hash} = JSON.parse(data); const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(update,'base64'));
    process.stdout.write(JSON.stringify(publicProjection(doc, new Set([hash])))); doc.destroy();`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: process.env.NEVIS_COLLABORATION_DIR,
    input: JSON.stringify({ update: Buffer.from(update).toString('base64'), hash }), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const projection = JSON.parse(result.stdout)
  assert.equal(projection.document.content[0].content[0].text, 'سلام')
  assert.deepEqual(projection.document.content[0].content[0].marks, ['bold'])
  assert.equal(projection.document.content[1].attachment, hash)
})
