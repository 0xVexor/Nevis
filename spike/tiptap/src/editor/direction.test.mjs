import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { blockDirections, firstTextDirection } from './headingDir.ts'

const attrs = { dir: { default: 'auto' } }
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*', attrs },
  heading: { group: 'block', content: 'inline*', attrs },
  bulletList: { group: 'block', content: 'listItem+' },
  orderedList: { group: 'block', content: 'listItem+' },
  taskList: { group: 'block', content: 'taskItem+' },
  listItem: { content: 'paragraph block*', attrs },
  taskItem: { content: 'paragraph block*', attrs },
} })
const p = text => schema.node('paragraph', null, text ? schema.text(text) : null)
const item = (type, text, extra = [], dir = 'auto') => schema.node(type, { dir }, [p(text), ...extra])
const directions = doc => blockDirections(doc).find().filter(d => !['bulletList', 'orderedList', 'taskList'].includes(doc.nodeAt(d.from).type.name)).sort((a, b) => a.from - b.from || b.to - a.to).map(d => d.type.attrs['data-dir'])

test('Persian lists detect their own text, including punctuation and numbers', () => {
  for (const [list, child] of [['bulletList', 'listItem'], ['orderedList', 'listItem'], ['taskList', 'taskItem']]) {
    const doc = schema.node('doc', null, schema.node(list, null, [item(child, '۱۲۳. سلام دنیا'), item(child, 'English task')]))
    assert.deepEqual(directions(doc), ['rtl', 'rtl', 'ltr', 'ltr'])
    assert.equal(doc.toJSON().content[0].content[0].attrs.dir, 'auto')
  }
})
test('nested lists decide independently and empty parent ignores nested text', () => {
  const nested = schema.node('bulletList', null, item('listItem', 'English'))
  const doc = schema.node('doc', null, schema.node('bulletList', null, item('listItem', 'فارسی', [nested])))
  assert.deepEqual(directions(doc), ['rtl', 'rtl', 'ltr', 'ltr'])
  const empty = schema.node('doc', null, schema.node('bulletList', null, item('listItem', '', [nested])))
  assert.deepEqual(directions(empty), ['ltr', 'ltr'])
})
test('manual direction wins and nested headings are visited', () => {
  const heading = schema.node('heading', null, schema.text('عنوان'))
  const doc = schema.node('doc', null, schema.node('taskList', null, item('taskItem', 'فارسی', [heading], 'ltr')))
  assert.deepEqual(directions(doc), ['ltr', 'ltr', 'ltr'])
})
test('typing, replacing and clearing text recomputes automatic direction', () => {
  assert.equal(firstTextDirection('123 سلام'), 'rtl')
  assert.equal(firstTextDirection('123 hello سلام'), 'ltr')
  assert.equal(firstTextDirection('۱۲۳ ...'), null)
  assert.equal(firstTextDirection('中文'), 'ltr')
})
