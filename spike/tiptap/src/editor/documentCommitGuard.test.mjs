import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { documentCommitPlugin } from './documentCommitGuard.ts'

test('editor commit guard rejects typing synchronously, permits selection, and unlocks', () => {
  let locked = false
  const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } })
  let state = EditorState.create({ schema, plugins: [documentCommitPlugin(() => locked)] })
  state = state.apply(state.tr.insertText('human draft'))
  locked = true
  assert.equal(state.applyTransaction(state.tr.insertText('blocked')).transactions.length, 0)
  assert.equal(state.applyTransaction(state.tr.setMeta('selectionOnly', true)).transactions.length, 1)
  locked = false
  state = state.apply(state.tr.insertText('!'))
  assert.equal(state.doc.textContent, 'human draft!')
})
