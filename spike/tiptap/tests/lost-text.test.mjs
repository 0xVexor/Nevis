import test from 'node:test'
import assert from 'node:assert/strict'
import { isLostText, lostTextField } from '../src/documents/lostText.ts'

test('text whose letters became question marks is recognised', () => {
  assert.ok(isLostText('????? ????? ????? NGDIR'))
  assert.ok(isLostText('????? ?????: ? ?????? ????? ????? ????? ?????.'))
  assert.ok(isLostText('? ???? ')) // a short node of a garbled document
  assert.ok(isLostText('bytes �� decoded wrongly'))
})

test('ordinary text with question marks stays fine', () => {
  for (const ok of ['Why?', 'What??', 'Really?!?', 'پیوست شواهد کنترل دسترسی NGDIR', 'const x = a ?? b ?? c', 'تو کجایی؟ ؟؟', 'a?b?c? is a regex', 'Is it done? Yes?? No???']) assert.equal(isLostText(ok), false, ok)
})

test('a request is checked as a whole and names the field', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }, { type: 'paragraph', content: [{ type: 'text', text: '????? ????? ????' }] }] }
  assert.equal(lostTextField({ documentId: 'abc', content: doc }), 'content')
  assert.equal(lostTextField({ documentId: 'abc', operations: [{ kind: 'insert_markdown', markdown: '# ????? ????? ????' }] }), 'operations')
  assert.equal(lostTextField({ documentId: 'abc', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'سلام دنیا' }] }] } }), null)
  assert.equal(lostTextField('not an object'), null)
})
