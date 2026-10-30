import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import { LayoutGroup, LayoutColumn, LayoutSafety } from '../src/editor/layout.ts'
import { BlockIdentity, blockIdentityPlugin } from '../src/editor/blockIdentity.ts'
import { identifyBlocks, BLOCK_TYPES } from '../src/documents/blockIdentity.ts'
import { contentProblem } from '../src/editor/contentSafety.ts'
import { DocumentService } from '../src/documents/service.ts'
import { MemoryDocumentStorage } from '../src/documents/memoryStorage.ts'

globalThis.window = { dispatchEvent() {} }
const schema = getSchema([StarterKit, LayoutGroup, LayoutColumn, BlockIdentity])
const content = () => identifyBlocks({ type: 'doc', content: [{ type: 'layoutGroup', attrs: { widths: [40, 60], direction: 'rtl' }, content:
  ['left', 'right'].map(label => ({ type: 'layoutColumn', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Example' }] },
    { type: 'paragraph', content: [{ type: 'text', text: label }] },
  ] })),
}] }).content
const ids = doc => { const result = []; doc.descendants(node => { if (BLOCK_TYPES.includes(node.type.name)) result.push(node.attrs.blockId) }); return result }

test('layout safety permits identity repair for a copied selected group, preserving originals and undo/redo', () => {
  const doc = schema.nodeFromJSON(content())
  let state = EditorState.create({ schema, doc, plugins: [history()] })
  const editor = { isEditable: true, view: { composing: false }, get state() { return state } }
  state = state.reconfigure({ plugins: [...state.plugins, ...LayoutSafety.config.addProseMirrorPlugins.call({ editor }), blockIdentityPlugin(randomUUID)] })
  const dispatch = tr => { state = state.applyTransaction(tr).state }
  const original = ids(doc)
  const tr = state.tr.insert(0, state.doc.firstChild).setMeta('layoutAction', true)
  dispatch(tr.setSelection(NodeSelection.create(tr.doc, 0)))
  const all = ids(state.doc)
  assert.equal(new Set(all).size, all.length)
  assert.ok(all.every(Boolean))
  assert.deepEqual(ids(state.doc.lastChild), original.slice(1)) // descendants exclude the passed root
  const copied = JSON.stringify(state.doc.toJSON())
  assert.ok(undo(state, dispatch))
  assert.equal(state.doc.childCount, 1)
  assert.ok(redo(state, dispatch))
  assert.equal(JSON.stringify(state.doc.toJSON()), copied)
  assert.deepEqual(state.doc.firstChild.attrs.widths, [40, 60])
  assert.equal(state.doc.firstChild.attrs.direction, 'rtl')
})

test('layout JSON survives schema/safety checks and MCP reads preserve columns and section boundaries', async () => {
  const body = content()
  assert.equal(contentProblem(body, schema), null)
  assert.ok(contentProblem({ ...body, attrs: { blockIdentityVersion: 2 } }, schema))
  assert.deepEqual(JSON.parse(JSON.stringify(schema.nodeFromJSON(body).toJSON())),
    JSON.parse(JSON.stringify(schema.nodeFromJSON(identifyBlocks(body).content).toJSON())))
  const storage = new MemoryDocumentStorage('layout-vault', [{ id: 'layout', parentId: null, title: 'layout', content: body, favorite: false, sort: 0, updatedAt: 1, deletedAt: null }])
  const host = { now: () => 1, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} }
  const service = new DocumentService({ storage, host })
  await service.init()
  const reader = service.reader({ context: { vaultHandle: 'layout-vault', grantId: 'grant', grantRevision: '1' }, isActive: () => true, canRead: () => true },
    { now: () => 1, cursorId: randomUUID, digest: async value => createHash('sha256').update(value).digest('hex') })
  const read = await reader.readDocument({ documentId: 'layout', target: { kind: 'full' }, format: 'both' })
  assert.deepEqual(read.chunks[0].structured, [body.content[0]])
  assert.equal(read.chunks[0].range.fromBlockId, body.content[0].attrs.blockId)
  assert.equal(read.chunks[0].markdown, null)
  assert.ok(read.warnings.some(item => item.code === 'UNSUPPORTED_CONTENT'))
  const heading = body.content[0].content[0].content[0]
  const section = await reader.readDocument({ documentId: 'layout', target: { kind: 'section', headingBlockId: heading.attrs.blockId }, format: 'markdown' })
  assert.equal(section.chunks.at(-1).markdown, 'left')
  assert.ok(section.chunks.every(chunk => chunk.markdown !== 'right'))
})
