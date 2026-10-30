import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { Schema, Fragment, Slice } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { BlockIdentity, blockIdentityPlugin } from './blockIdentity.ts'

const attrs = { blockId: { default: null }, dir: { default: 'auto' } }
const schema = new Schema({ nodes: {
  doc: { content: 'block+', attrs: { blockIdentityVersion: { default: 0 } } },
  text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*', attrs },
  blockquote: { group: 'block', content: 'block+', attrs },
} })
const p = (text = '', id = null) => schema.node('paragraph', { blockId: id, dir: 'rtl' }, text ? schema.text(text) : null)
const identity = doc => { const out = []; doc.descendants(n => { if (n.isBlock) out.push(n.attrs.blockId) }); return out }
function setup(nodes) {
  let next = 0
  const plugin = blockIdentityPlugin(() => `new_${++next}`)
  let state = EditorState.create({ schema, doc: schema.node('doc', null, nodes), plugins: [plugin] })
  state = state.applyTransaction(state.tr.setMeta('blockIdentity:init', true)).state
  return { plugin, get state() { return state }, apply(tr) { state = state.applyTransaction(tr).state; return state } }
}

test('actual TipTap global attributes survive JSON reconstruction', () => {
  const actual = getSchema([Document, Paragraph, Text, BlockIdentity])
  const json = { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [
    { type: 'paragraph', attrs: { blockId: 'persisted' }, content: [{ type: 'text', text: 'فارسی' }] },
  ] }
  assert.deepEqual(JSON.parse(JSON.stringify(actual.nodeFromJSON(json).toJSON())), json)
})

test('initialization, typing and splitting keep existing targets and assign new ones', () => {
  const h = setup([p('سلام')])
  const before = identity(h.state.doc)[0]
  h.apply(h.state.tr.insertText('!', 2))
  assert.equal(identity(h.state.doc)[0], before)
  h.apply(h.state.tr.split(3))
  const after = identity(h.state.doc)
  assert.equal(after[0], before)
  assert.equal(new Set(after).size, 2)
  assert.ok(after.every(Boolean))
  assert.equal(h.state.doc.attrs.blockIdentityVersion, 1)
  assert.equal(h.state.doc.firstChild.attrs.dir, 'rtl')
})

test('programmatic copy before original preserves the mapped original owner', () => {
  const h = setup([p('original', 'owned')])
  h.apply(h.state.tr.insert(0, h.state.doc.firstChild))
  assert.notEqual(h.state.doc.firstChild.attrs.blockId, 'owned')
  assert.equal(h.state.doc.lastChild.attrs.blockId, 'owned')
})

test('nested clipboard copies refresh IDs while internal drag moves preserve them', () => {
  const h = setup([schema.node('blockquote', { blockId: 'quote' }, p('nested', 'child')), p('other', 'other')])
  const slice = new Slice(Fragment.from(h.state.doc.firstChild), 0, 0)
  const copy = h.plugin.props.transformPasted(slice, { dragging: null })
  assert.equal(copy.content.firstChild.attrs.blockId, null)
  h.apply(h.state.tr.insert(0, copy.content))
  assert.equal(new Set(identity(h.state.doc)).size, 5)
  assert.equal(h.plugin.props.transformPasted(slice, { dragging: {} }), slice)
  const moving = h.state.doc.lastChild
  h.apply(h.state.tr.delete(h.state.doc.content.size - moving.nodeSize, h.state.doc.content.size).insert(0, moving))
  assert.equal(h.state.doc.firstChild.attrs.blockId, 'other')
})

test('undo/redo restores the same assigned identity', async () => {
  const { history, undo, redo } = await import('@tiptap/pm/history')
  let next = 0
  let state = EditorState.create({ schema, doc: schema.node('doc', { blockIdentityVersion: 1 }, [p('old', 'old')]),
    plugins: [history(), blockIdentityPlugin(() => `undo_${++next}`)] })
  const dispatch = tr => { state = state.applyTransaction(tr).state }
  dispatch(state.tr.insert(state.doc.content.size, p('new')))
  const insertedId = state.doc.lastChild.attrs.blockId
  assert.equal(undo(state, dispatch), true)
  assert.equal(state.doc.childCount, 1)
  assert.equal(redo(state, dispatch), true)
  assert.equal(state.doc.lastChild.attrs.blockId, insertedId)
})

test('initial identity assignment is not a separate user undo step', async () => {
  const { history, undo } = await import('@tiptap/pm/history')
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [p('legacy')]),
    plugins: [history(), blockIdentityPlugin(() => 'initial')] })
  const dispatch = tr => { state = state.applyTransaction(tr).state }
  dispatch(state.tr.setMeta('blockIdentity:init', true).setMeta('addToHistory', false))
  assert.equal(state.doc.firstChild.attrs.blockId, 'initial')
  assert.equal(undo(state, dispatch), false)
})
