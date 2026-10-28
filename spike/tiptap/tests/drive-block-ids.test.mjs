import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import { StableBlockIds, enableDriveBlockIds } from '../src/editor/stableBlockIds'
const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block', attrs: { stableBlockId: { default: null } } }, text: { group: 'inline' } } })
const para = (text, id = null) => schema.node('paragraph', { stableBlockId: id }, text ? schema.text(text) : [])
const plugins = () => [...StableBlockIds.config.addProseMirrorPlugins.call({}), history()]
test('Drive block IDs preserve pasted text, regenerate duplicates and survive undo/redo', () => {
  enableDriveBlockIds(true)
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [para('فارسی 🧪', 'original')]), plugins: plugins() })
  state = state.applyTransaction(state.tr.insert(state.doc.content.size, para('کپی', 'original'))).state
  const ids = [state.doc.child(0).attrs.stableBlockId, state.doc.child(1).attrs.stableBlockId]
  assert.equal(ids[0], 'original'); assert.notEqual(ids[1], ids[0]); assert.equal(typeof ids[1], 'string')
  assert.equal(state.doc.child(1).textContent, 'کپی')
  undo(state, tr => { state = state.applyTransaction(tr).state }); assert.equal(state.doc.childCount, 1)
  redo(state, tr => { state = state.applyTransaction(tr).state }); assert.equal(state.doc.childCount, 2); assert.equal(state.doc.child(1).attrs.stableBlockId, ids[1])
  enableDriveBlockIds(false)
})
test('local-only documents do not receive new identities; existing Drive IDs are preserved', () => {
  enableDriveBlockIds(false)
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [para('local')]), plugins: plugins() })
  state = state.applyTransaction(state.tr.insertText('!', 1)).state; assert.equal(state.doc.child(0).attrs.stableBlockId, null)
  state = EditorState.create({ schema, doc: schema.node('doc', null, [para('drive', 'existing')]), plugins: plugins() })
  state = state.applyTransaction(state.tr.insert(state.doc.content.size, para('new'))).state
  assert.equal(state.doc.child(0).attrs.stableBlockId, 'existing'); assert.ok(state.doc.child(1).attrs.stableBlockId)
})
