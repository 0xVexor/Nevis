import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { schemaExtensions } from '@nevis/schema'
import { blockRange, displayWidths, layoutStructureValid, withWidths } from '../src/editor/layoutModel'
import { outsideSnapTarget, planSnap, snapTransaction, type SnapContext, type SnapTarget } from '../src/editor/snapModel'

const schema = getSchema(schemaExtensions)
const paragraph = (text: string) => schema.nodes.paragraph!.create(null, text ? schema.text(text, [schema.marks.bold!.create()]) : undefined)
const group = (labels: string[], widths = labels.map(() => 100 / labels.length)) => withWidths(schema.nodes.layoutGroup!.create(null, labels.map(label => schema.nodes.layoutColumn!.create(null, paragraph(label)))), widths)
const doc = (...children: PMNode[]) => schema.nodes.doc!.create(null, children)
const context = (rtl = false): SnapContext => ({ rtl, groupRTL: () => rtl })
const contents = (node: PMNode) => { const text: string[] = []; node.descendants(n => { if (n.isTextblock && n.textContent) text.push(n.textContent) }); return text.sort() }
const stateAt = (document: PMNode, pos: number) => EditorState.create({ schema, doc: document, selection: NodeSelection.create(document, pos) })
function apply(state: EditorState, target: SnapTarget, ctx = context()) {
  const source = blockRange(state)!
  const result = planSnap(state, source, target, ctx)
  if (!result.plan) throw new Error(result.error)
  const transaction = snapTransaction(state, result.plan)
  expect(transaction).not.toBeNull()
  const next = state.apply(transaction!)
  next.doc.check()
  expect(layoutStructureValid(next.doc)).toBe(true)
  expect(contents(next.doc)).toEqual(contents(state.doc))
  return next
}

describe('reference layout planner on the scalar-width Yjs schema', () => {
  it.each([false, true])('creates two columns in physical direction (RTL=%s) without losing marked text', rtl => {
    const source = paragraph('A'), target = paragraph('B')
    const state = stateAt(doc(source, target, paragraph('C')), 0)
    const next = apply(state, { kind: 'pair', targetFrom: source.nodeSize, side: 'right' }, context(rtl))
    const layout = next.doc.child(0)
    expect(layout.childCount).toBe(2)
    expect(displayWidths(layout)).toEqual([50, 50])
    expect(layout.child(0).attrs.width).toBe(50000)
    layout.descendants(node => { if (node.isText) expect(node.marks[0]?.type.name).toBe('bold') })
  })

  it('adds a third column with scalar integer widths and keeps existing content', () => {
    const layout = group(['A', 'B'], [30, 70])
    const state = stateAt(doc(layout, paragraph('C')), layout.nodeSize)
    const next = apply(state, { kind: 'column-gap', groupPos: 0, visualGap: 1 })
    expect(next.doc.child(0).childCount).toBe(3)
    next.doc.child(0).forEach(column => expect(Number.isInteger(column.attrs.width)).toBe(true))
    expect(displayWidths(next.doc.child(0))).toEqual([100 / 3, 100 / 3, 100 / 3])
  })

  it('rejects a fourth column without dispatching a partial move', () => {
    const layout = group(['A', 'B', 'C'])
    const state = stateAt(doc(layout, paragraph('D')), layout.nodeSize)
    const before = state.doc.toJSON()
    expect(planSnap(state, blockRange(state)!, { kind: 'column-gap', groupPos: 0, visualGap: 1 }, context()).error).toBe('max-columns')
    expect(state.doc.toJSON()).toEqual(before)
  })

  it('extracts a whole column and flattens the remaining single column safely', () => {
    const layout = group(['A', 'B'], [40, 60])
    const state = stateAt(doc(layout, paragraph('C')), 2)
    const source = blockRange(state)!
    const target = outsideSnapTarget(state, source, 'after')!
    const next = apply(state, target)
    expect(next.doc.childCount).toBe(3)
    expect(next.doc.child(0).type.name).toBe('paragraph')
    expect(next.doc.textContent).toBe('BAC')
  })

  it('moves a root block while retaining the untouched layout and its widths', () => {
    const layout = group(['A', 'B'], [35, 65]), source = paragraph('C')
    const state = stateAt(doc(source, layout, paragraph('D')), 0)
    const next = apply(state, { kind: 'insert', pos: state.doc.content.size })
    expect(next.doc.child(0)).toBe(layout)
    expect(displayWidths(next.doc.child(0))).toEqual([35, 65])
  })

  it('keeps every text block once across varied pairings and both directions', () => {
    for (let count = 2; count <= 12; count++) for (const rtl of [false, true]) {
      const nodes = Array.from({ length: count }, (_, i) => paragraph(`block-${i}`))
      for (let index = 1; index < count; index++) {
        const state = stateAt(doc(...nodes), 0)
        const targetFrom = nodes.slice(0, index).reduce((sum, node) => sum + node.nodeSize, 0)
        apply(state, { kind: 'pair', targetFrom, side: index % 2 ? 'left' : 'right' }, context(rtl))
      }
    }
  })
})
