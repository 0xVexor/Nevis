import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { auditSchema, schema } from '../src'

describe('schema audit (ADR-0003 §5)', () => {
  it('the real schema passes: no null/object/array/float default, blockId on every block, dir defaults to auto', () => {
    expect(auditSchema(schema)).toEqual([])
  })
  it('the audit is not vacuous: it names a null default, an object default, a float, a missing default and a block without an id', () => {
    const bad = new Schema({
      nodes: {
        doc: { content: 'block*' },
        text: { group: 'inline' },
        paragraph: { group: 'block', content: 'inline*', attrs: { nul: { default: null }, obj: { default: { a: 1 } }, f: { default: 1.5 }, none: {}, dir: { default: 'rtl' } } },
      },
    })
    const found = auditSchema(bad).join('\n')
    for (const needle of ['paragraph.nul', 'paragraph.obj', 'paragraph.f', 'paragraph.none: no default', 'paragraph.dir: default must be "auto"', 'paragraph: a block without blockId']) expect(found).toContain(needle)
  })
})
