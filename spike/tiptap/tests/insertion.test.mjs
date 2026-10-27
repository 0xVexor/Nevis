import test from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { insertionAnchor } from '../src/editor/insertionAnchor.ts'

const schema = getSchema([StarterKit])
function harness() {
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('start end'))) })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)))
  const listeners = new Map()
  let inserted = null
  const editor = {
    isDestroyed: false, isEditable: true,
    get state() { return state },
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener) },
    off(event, listener) { listeners.get(event)?.delete(listener) },
    chain() { return { focus() { return this }, insertContentAt(position, content) { inserted = { position, content }; return this }, run() { return true } } },
  }
  const apply = (tr) => { state = state.apply(tr); for (const listener of [...(listeners.get('transaction') ?? [])]) listener({ transaction: tr, appendedTransactions: [] }) }
  return { editor, apply, listeners, get inserted() { return inserted }, get state() { return state } }
}

test('async insertion keeps its original position when the user moves the caret', () => {
  const h = harness(), anchor = insertionAnchor(h.editor)
  h.apply(h.state.tr.setSelection(TextSelection.create(h.state.doc, 2)))
  assert.ok(anchor.insert({ type: 'databaseEmbed', attrs: { containerId: 'C1' } }))
  assert.equal(h.inserted.position, 6)
  anchor.release()
  assert.equal(h.listeners.get('transaction').size, 0)
  assert.equal(h.listeners.get('destroy').size, 0)
})

test('async insertion maps through preceding edits, but cancels if its source is removed', () => {
  const h = harness(), anchor = insertionAnchor(h.editor)
  h.apply(h.state.tr.insertText('new ', 1))
  assert.ok(anchor.insert({ type: 'databaseEmbed' }))
  assert.equal(h.inserted.position, 10)
  h.apply(h.state.tr.delete(2, 12))
  assert.equal(anchor.isValid(), false)
  assert.equal(anchor.insert({ type: 'databaseEmbed' }), false)
  anchor.release()
})

test('full document replacement and editor destruction invalidate async insertions', () => {
  const h = harness(), anchor = insertionAnchor(h.editor)
  h.apply(h.state.tr.replaceWith(0, h.state.doc.content.size, schema.nodes.paragraph.create(null, schema.text('replacement'))))
  assert.equal(anchor.isValid(), false)
  anchor.release()
  const closed = harness(), pending = insertionAnchor(closed.editor)
  closed.editor.isDestroyed = true
  for (const listener of [...closed.listeners.get('destroy')]) listener()
  assert.equal(pending.insert({ type: 'databaseEmbed' }), false)
  assert.equal(closed.listeners.get('transaction').size, 0)
})
