import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'

export const GROUP = 'layoutGroup'
export const COLUMN = 'layoutColumn'
export const GAP = 24
export const MIN_WIDTH = 180
export const equalWidths = (count: number) => Array.from({ length: count }, () => 100 / count)
export function validWidths(value: unknown, count: number): value is number[] {
  return Array.isArray(value) && value.length === count && value.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 20) && Math.abs(value.reduce((a, b) => a + b, 0) - 100) < 0.01
}
export const displayWidths = (node: PMNode): number[] => validWidths(node.attrs.widths, node.childCount) ? node.attrs.widths : equalWidths(node.childCount)
export function ancestor($pos: ResolvedPos, type: string) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === type) return { node: $pos.node(d), pos: $pos.before(d), depth: d }
  return null
}
export function activeGroup(state: EditorState) {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === GROUP) return { node: selection.node, pos: selection.from, depth: 1 }
  return ancestor(selection.$from, GROUP)
}
export function flow($pos: ResolvedPos) {
  const col = ancestor($pos, COLUMN)
  return col ? { node: col.node, start: col.pos + 1, depth: col.depth } : { node: $pos.doc, start: 0, depth: 0 }
}
export function crossesColumns(state: EditorState) {
  const { selection: s } = state
  if (s.empty || (s instanceof NodeSelection && s.node.type.name === GROUP)) return false
  const a = ancestor(s.$from, COLUMN), b = ancestor(s.$to, COLUMN)
  if (a?.pos !== b?.pos) return true
  if (a && b) return false
  // A text selection can start/end outside layouts while enclosing a complete group.
  let crossed = false
  state.doc.nodesBetween(s.from, s.to, (n) => { if (n.type.name === GROUP) crossed = true })
  return crossed
}

export interface BlockRange { from: number; to: number; nodes: PMNode[]; flowStart: number; flowNode: PMNode }
/** Whole blocks in a single document/column flow; partial text is intentionally rejected. */
export function blockRange(state: EditorState, caret = true): BlockRange | null {
  const s = state.selection
  if (crossesColumns(state)) return null
  const f = flow(s.$from)
  if (s instanceof NodeSelection) {
    if (s.$from.depth !== f.depth) return null
    return { from: s.from, to: s.to, nodes: [s.node], flowStart: f.start, flowNode: f.node }
  }
  if (s.empty) {
    if (!caret || s.$from.depth <= f.depth) return null
    const from = s.$from.before(f.depth + 1), node = state.doc.nodeAt(from)!
    return { from, to: from + node.nodeSize, nodes: [node], flowStart: f.start, flowNode: f.node }
  }
  // Normal full paragraph selections run from the first text position to the last.
  const from = s.$from.depth > f.depth ? s.$from.before(f.depth + 1) : s.from
  const to = s.$to.depth > f.depth ? s.$to.after(f.depth + 1) : s.to
  const first = state.doc.nodeAt(from)
  const lastPos = state.doc.resolve(Math.max(from, to - 1))
  const last = lastPos.depth > f.depth ? lastPos.node(f.depth + 1) : null
  const textStart = first?.isTextblock ? from + 1 : from
  const textEnd = last?.isTextblock ? to - 1 : to
  if (s.from !== from && s.from !== textStart) return null
  if (s.to !== to && s.to !== textEnd) return null
  const nodes: PMNode[] = []
  for (let pos = from; pos < to;) {
    const node = state.doc.nodeAt(pos)
    if (!node || pos + node.nodeSize > to) return null
    nodes.push(node); pos += node.nodeSize
  }
  return nodes.length ? { from, to, nodes, flowStart: f.start, flowNode: f.node } : null
}
export function groupColumns(doc: PMNode) {
  const result: { group: number; column: number; pos: number; node: PMNode; groupPos: number }[] = []
  let group = 0
  doc.forEach((node, groupPos) => {
    if (node.type.name !== GROUP) return
    group++
    node.forEach((col, offset, column) => result.push({ group, column: column + 1, pos: groupPos + 1 + offset, node: col, groupPos }))
  })
  return result
}
export function focusIn(tr: Transaction, pos: number) {
  tr.setSelection(Selection.near(tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)))))
  return tr.scrollIntoView()
}
export function structural(tr: Transaction) { return closeHistory(tr).setMeta('layoutAction', true) }
export function flattenGroup(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach((col) => col.forEach((block) => out.push(block)))
  return out
}
export function moveBlocks(state: EditorState, range: BlockRange, target: number, transaction = state.tr): Transaction | null {
  if (target >= range.from && target <= range.to) return null
  const $target = state.doc.resolve(target)
  const dest = flow($target)
  if ($target.depth !== dest.depth) return null
  if (dest.node.type.name === COLUMN && range.nodes.some((n) => n.type.name === GROUP)) return null
  const tr = structural(transaction)
  const firstStep = tr.steps.length
  const fragment = Fragment.fromArray(range.nodes)
  // Retain an editable paragraph when moving every block out of a column.
  const empty = range.flowNode.type.name === COLUMN && range.from === range.flowStart && range.to === range.flowStart + range.flowNode.content.size
  if (empty) tr.replaceWith(range.from, range.to, state.schema.nodes.paragraph.create())
  else tr.delete(range.from, range.to)
  const at = tr.mapping.slice(firstStep).map(target, target < range.from ? -1 : 1)
  tr.insert(at, fragment)
  if (range.nodes.length === 1 && (range.nodes[0].type.name === GROUP || range.nodes[0].isAtom)) tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView()
  else focusIn(tr, at + 1)
  return tr
}
/** A complete linear copy of touched flow blocks, without incomplete column wrappers. */
export function linearSelection(state: EditorState): Fragment {
  const nodes: PMNode[] = []
  const { from, to } = state.selection
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name === GROUP || node.type.name === COLUMN) return true
    if (parent?.type.name === 'doc' || parent?.type.name === COLUMN) {
      if (pos < to && pos + node.nodeSize > from) nodes.push(node)
      return false
    }
    return true
  })
  return Fragment.fromArray(nodes)
}
export function flattenLayouts(fragment: Fragment): Fragment {
  const out: PMNode[] = []
  fragment.forEach((node) => {
    if (node.type.name === GROUP) out.push(...flattenGroup(node))
    else if (node.type.name === COLUMN) node.forEach((n) => out.push(n))
    else out.push(node.isLeaf ? node : node.copy(flattenLayouts(node.content)))
  })
  return Fragment.fromArray(out)
}
/** Structural validity beyond PM's content expression (groups are root-only). */
export function layoutStructureValid(doc: PMNode) {
  let valid = true
  doc.descendants((n, _pos, parent) => {
    if (n.type.name === GROUP && (parent?.type.name !== 'doc' || n.childCount < 2 || n.childCount > 3 || ![null, 'rtl', 'ltr'].includes(n.attrs.direction))) valid = false
    if (n.type.name === COLUMN && parent?.type.name !== GROUP) valid = false
  })
  return valid
}
export function boundaryKey(state: EditorState, backwards: boolean) {
  if (!state.selection.empty) return false
  const { $from } = state.selection, col = ancestor($from, COLUMN)
  if (!col) return false
  const edge = backwards ? col.pos + 1 : col.pos + col.node.nodeSize - 1
  const near = TextSelection.findFrom(state.doc.resolve(edge), backwards ? 1 : -1, true)
  return near?.from === state.selection.from
}

/** Adjacent editable position in document order when the caret is at a column boundary. */
export function adjacentColumnSelection(state: EditorState, backwards: boolean) {
  if (!boundaryKey(state, backwards)) return null
  const column = ancestor(state.selection.$from, COLUMN)
  if (!column) return null
  const edge = backwards ? column.pos : column.pos + column.node.nodeSize
  return Selection.findFrom(state.doc.resolve(edge), backwards ? -1 : 1)
}
