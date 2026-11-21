import { describe, expect, it } from 'vitest'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { BODY, attrValues, isBlockId, normalize, project, schema, uuidv7, type PMJson } from '../src'
import { allFixtures as fixtures, fixturesV2, fixturesV3 } from './fixtures'

const toDoc = (json: PMJson) => {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(schema, normalize(json), doc.getXmlFragment(BODY))
  return doc
}
const names = Object.keys(fixtures)

describe('schema contract', () => {
  it('loads in plain Node and has the planned node and mark set', () => {
    for (const n of ['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableHeader', 'tableCell', 'hardBreak', 'text']) expect(schema.nodes[n], n).toBeDefined()
    for (const m of ['bold', 'italic', 'code', 'link']) expect(schema.marks[m], m).toBeDefined()
    expect(schema.nodes.heading!.spec.attrs).toBeDefined()
  })

  it('has the 10 sv1 fixtures, the sv2 ones and the sv3 ones', () => expect([names.length, Object.keys(fixturesV2).length, Object.keys(fixturesV3).length]).toEqual([10 + Object.keys(fixturesV2).length + Object.keys(fixturesV3).length, 12, 1]))

  it.each(names)('round trip through Yjs keeps %s identical (defaults filled in)', name => {
    const input = normalize(fixtures[name]!)
    const out = project(toDoc(fixtures[name]!))
    expect(out).toEqual(input)
    // a fresh replica that only receives the encoded state projects the same page
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(toDoc(fixtures[name]!)))
    expect(project(copy)).toEqual(input)
  })

  it.each(names)('no attribute is null or an object in %s', name => {
    for (const [path, v] of attrValues(project(toDoc(fixtures[name]!)))) {
      expect(v, path).not.toBeNull()
      expect(v, path).not.toBeUndefined()
      expect(['string', 'number', 'boolean'], path).toContain(typeof v)
    }
  })

  it('keeps dir on paragraphs, headings and tables, and ids on every block', () => {
    const table = project(toDoc(fixtures.rtlTable!)).content![0]!
    expect(table.attrs!.dir).toBe('rtl')
    expect(project(toDoc(fixtures.directions!)).content!.map(b => b.attrs!.dir)).toEqual(['auto', 'rtl', 'ltr'])
    const ids: string[] = []
    const walk = (n: PMJson) => { if (n.attrs && 'blockId' in n.attrs) ids.push(n.attrs.blockId as string); n.content?.forEach(walk) }
    walk(project(toDoc(fixtures.lists!)))
    expect(ids.length).toBeGreaterThan(4)
    expect(ids.every(isBlockId)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps ZWNJ and Persian digits untouched', () => {
    const text = project(toDoc(fixtures.mixed!)).content![0]!.content![0]!.text!
    expect(text).toContain('می‌خواهم')
    expect(text).toContain('۱۴۰۵/۰۸/۳۰')
  })

  it('uuidv7 is well formed, time ordered and unique', () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001)
    expect(isBlockId(a)).toBe(true)
    expect(a < b).toBe(true)
    expect(a.split('-')[2]![0]).toBe('7')
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000)
  })
})
