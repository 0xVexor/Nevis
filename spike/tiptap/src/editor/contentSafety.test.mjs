import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { contentProblem } from './contentSafety.ts'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*', attrs: { dir: { default: 'auto' } } },
}, marks: { strong: {} } })
const valid = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'متن محفوظ' }] }] }
test('supported content remains editable without changing raw JSON', () => {
  const before = JSON.stringify(valid)
  assert.equal(contentProblem(valid, schema), null)
  assert.equal(JSON.stringify(valid), before)
})
test('a newer node, mark or attribute fails closed without discarding raw content', () => {
  for (const change of [
    d => d.content.push({ type: 'futureLayout', attrs: { data: 'preserve me' } }),
    d => { d.content[0].attrs = { futureAttribute: 'preserve me' } },
    d => { d.content[0].content[0].marks = [{ type: 'futureMark' }] },
  ]) {
    const doc = structuredClone(valid)
    change(doc)
    const before = JSON.stringify(doc)
    assert.ok(contentProblem(doc, schema))
    assert.equal(JSON.stringify(doc), before)
  }
})
test('malformed and structurally invalid JSON fail closed', () => {
  for (const doc of [null, {}, { type: 'doc', content: [{ type: 'text', text: 'invalid block' }] }]) assert.ok(contentProblem(doc, schema))
})
