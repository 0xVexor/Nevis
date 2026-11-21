// Ported from the old editor's direction.test.mjs (same cases, same expectations).
import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { blockDirections, firstTextDirection } from '../src/direction'

const attrs = { dir: { default: 'auto' } }
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*', attrs },
  heading: { group: 'block', content: 'inline*', attrs },
  bulletList: { group: 'block', content: 'listItem+' },
  orderedList: { group: 'block', content: 'listItem+' },
  taskList: { group: 'block', content: 'taskItem+' },
  blockquote: { group: 'block', content: 'block+' },
  listItem: { content: 'paragraph block*', attrs },
  taskItem: { content: 'paragraph block*', attrs },
} })
const p = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : null)
const item = (type: string, text: string, extra: ReturnType<typeof p>[] = [], dir = 'auto') => schema.node(type, { dir }, [p(text), ...extra])
const directions = (doc: ReturnType<typeof schema.node>) => blockDirections(doc).find().filter(d => !['bulletList', 'orderedList', 'taskList'].includes(doc.nodeAt(d.from)!.type.name)).sort((a, b) => a.from - b.from || b.to - a.to).map(d => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-dir'])

describe('direction', () => {
  it('Persian lists detect their own text, including punctuation and numbers', () => {
    for (const [list, child] of [['bulletList', 'listItem'], ['orderedList', 'listItem'], ['taskList', 'taskItem']] as const) {
      const doc = schema.node('doc', null, schema.node(list, null, [item(child, '۱۲۳. سلام دنیا'), item(child, 'English task')]))
      expect(directions(doc)).toEqual(['rtl', 'rtl', 'ltr', 'ltr'])
      expect(doc.toJSON().content[0].content[0].attrs.dir).toBe('auto') // render-only: nothing is written
    }
  })
  it('nested lists decide independently and an empty parent ignores nested text', () => {
    const nested = schema.node('bulletList', null, item('listItem', 'English'))
    const doc = schema.node('doc', null, schema.node('bulletList', null, item('listItem', 'فارسی', [nested as never])))
    expect(directions(doc)).toEqual(['rtl', 'rtl', 'ltr', 'ltr'])
    const empty = schema.node('doc', null, schema.node('bulletList', null, item('listItem', '', [nested as never])))
    expect(directions(empty)).toEqual(['ltr', 'ltr'])
  })
  it('manual direction wins and nested headings are visited', () => {
    const heading = schema.node('heading', null, schema.text('عنوان'))
    const doc = schema.node('doc', null, schema.node('taskList', null, item('taskItem', 'فارسی', [heading as never], 'ltr')))
    expect(directions(doc)).toEqual(['ltr', 'ltr', 'ltr'])
  })
  it('the first LETTER decides: digits and punctuation do not', () => {
    expect(firstTextDirection('123 سلام')).toBe('rtl')
    expect(firstTextDirection('123 hello سلام')).toBe('ltr')
    expect(firstTextDirection('۱۲۳ ...')).toBeNull()
    expect(firstTextDirection('中文')).toBe('ltr')
  })
  it('a quote follows its own text so its bar sits on the text side', () => {
    const doc = schema.node('doc', null, [schema.node('blockquote', null, p('نقل قول')), schema.node('blockquote', null, p('A quote'))])
    expect(directions(doc)).toEqual(['rtl', 'rtl', 'ltr', 'ltr'])
  })
})
