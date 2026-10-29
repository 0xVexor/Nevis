import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import {
  COLUMN, GROUP, GAP, MIN_WIDTH, ancestor, displayWidths, equalWidths, focusIn,
  layoutStructureValid, structural, validWidths, type BlockRange,
} from './layoutModel'

export type SnapTarget =
  | { kind: 'insert'; pos: number }
  | { kind: 'pair'; targetFrom: number; side: 'left' | 'right' }
  | { kind: 'column-gap'; groupPos: number; visualGap: number }

export type SnapFailure = 'invalid-source' | 'invalid-target' | 'nested-layout' | 'max-columns' | 'no-change'
export interface SnapContext { rtl: boolean; groupRTL: (pos: number) => boolean }
interface Block { node: PMNode; from: number | null }
interface Column { node: PMNode; from: number | null; blocks: Block[]; width: number }
interface Root extends Block { columns?: Column[]; widths?: unknown }
export interface SnapPlan {
  roots: PMNode[]
  focus: number
  /** Final logical widths, used by the UI to preview the very same operation. */
  columns?: { widths: number[]; active: number; rtl: boolean; action: 'pair' | 'add' | 'reorder' }
  extraction?: { side: 'before' | 'after'; remainingWidths: number[]; rtl: boolean }
}
export type SnapResult = { plan: SnapPlan; error?: never } | { error: SnapFailure; plan?: never }

const children = (node: PMNode, start: number): Block[] => {
  const out: Block[] = []
  node.forEach((child, offset) => out.push({ node: child, from: start + offset }))
  return out
}
const sameAttrs = (a: PMNode, b: PMNode) => JSON.stringify(a.attrs) === JSON.stringify(b.attrs)
const disposable = (block: Block) => block.node.type.name === 'paragraph'
  && block.node.content.size === 0 && block.node.marks.length === 0
  && sameAttrs(block.node, block.node.type.create())

export const snapKey = (target: SnapTarget) => target.kind === 'insert' ? `i:${target.pos}`
  : target.kind === 'pair' ? `p:${target.targetFrom}:${target.side}` : `g:${target.groupPos}:${target.visualGap}`

export function fitsSnapColumns(width: number, widths: number[]) {
  const usable = width - GAP * (widths.length - 1)
  return usable > 0 && widths.every((value) => usable * value / 100 >= MIN_WIDTH)
}

/** Extract the selected flow blocks to the root; never flatten unrelated columns. */
export function outsideSnapTarget(state: EditorState, source: BlockRange, side: 'before' | 'after'): SnapTarget | null {
  const $source = state.doc.resolve(source.from)
  const column = ancestor($source, COLUMN), group = ancestor($source, GROUP)
  if (!column || !group || source.flowNode !== column.node || source.flowStart !== column.pos + 1) return null
  return { kind: 'insert', pos: group.pos + (side === 'after' ? group.node.nodeSize : 0) }
}

/** Moving past a column's first/last block exits the group, never enters its sibling wrapper. */
export function verticalSnapTarget(state: EditorState, source: BlockRange, direction: 'up' | 'down'): SnapTarget | null {
  const $from = state.doc.resolve(source.from), $to = state.doc.resolve(source.to)
  const column = ancestor($from, COLUMN), group = ancestor($from, GROUP)
  if (direction === 'up') {
    const before = $from.nodeBefore
    if (before) return { kind: 'insert', pos: source.from - before.nodeSize }
    return column && group ? { kind: 'insert', pos: group.pos } : null
  }
  // nodeAt at a closing token is not a next block. Resolve within the source flow.
  const after = $to.nodeAfter
  if (after) return { kind: 'insert', pos: source.to + after.nodeSize }
  return column && group ? { kind: 'insert', pos: group.pos + group.node.nodeSize } : null
}

/** An exhausted column can be reordered by hovering a sibling's body. */
export function wholeSourceColumn(state: EditorState, source: BlockRange) {
  const $source = state.doc.resolve(source.from)
  const column = ancestor($source, COLUMN), group = ancestor($source, GROUP)
  if (!column || !group || source.flowNode !== column.node || source.flowStart !== column.pos + 1) return null
  let complete = true
  column.node.forEach((node, offset) => {
    const from = column.pos + 1 + offset
    if ((from < source.from || from >= source.to) && !disposable({ node, from })) complete = false
  })
  return complete ? { groupPos: group.pos, logicalIndex: $source.index(group.depth) } : null
}

/** Physical arrow directions stay the same in RTL. Use the same targets as pointer snapping. */
export function directionalSnapTarget(state: EditorState, source: BlockRange, side: 'left' | 'right', context: SnapContext):
  { target: SnapTarget; error?: never } | { error: SnapFailure; target?: never } {
  if (source.nodes.some((node) => node.type.name === GROUP)) return { error: 'no-change' }
  const $source = state.doc.resolve(source.from)
  const column = ancestor($source, COLUMN), group = ancestor($source, GROUP)
  if (column && group) {
    const logicalIndex = $source.index(group.depth), count = group.node.childCount
    const rtl = context.groupRTL(group.pos)
    const visualIndex = rtl ? count - 1 - logicalIndex : logicalIndex
    let exhausts = true
    column.node.forEach((node, offset) => {
      const from = column.pos + 1 + offset
      if ((from < source.from || from >= source.to) && !disposable({ node, from })) exhausts = false
    })
    if (exhausts) {
      // The two gaps touching this column are no-ops; cross the adjacent column instead.
      const gap = side === 'left' ? visualIndex - 1 : visualIndex + 2
      return gap < 0 || gap > count ? { error: 'no-change' }
        : { target: { kind: 'column-gap', groupPos: group.pos, visualGap: gap } }
    }
    if (count < 3) return { target: {
      kind: 'column-gap', groupPos: group.pos, visualGap: visualIndex + (side === 'right' ? 1 : 0),
    } }
    const adjacent = visualIndex + (side === 'left' ? -1 : 1)
    if (adjacent < 0 || adjacent >= count) return { error: 'no-change' }
    const index = rtl ? count - 1 - adjacent : adjacent
    let pos = group.pos + 1
    for (let i = 0; i < index; i++) pos += group.node.child(i).nodeSize
    return { target: { kind: 'insert', pos: pos + 1 + group.node.child(index).content.size } }
  }
  const previous = $source.nodeBefore
  const neighbor = previous ?? state.doc.nodeAt(source.to)
  if (!neighbor) return { error: 'no-change' }
  const at = previous ? source.from - previous.nodeSize : source.to
  if (neighbor.type.name === GROUP) return neighbor.childCount >= 3 ? { error: 'max-columns' }
    : { target: { kind: 'column-gap', groupPos: at, visualGap: side === 'left' ? 0 : neighbor.childCount } }
  return { target: { kind: 'pair', targetFrom: at, side } }
}

/** Pure planning. No DOM, dispatch, persistence, mutation of PM nodes, or selection dependency. */
export function planSnap(state: EditorState, source: BlockRange, target: SnapTarget, context: SnapContext): SnapResult {
  const roots: Root[] = []
  state.doc.forEach((node, from) => {
    const root: Root = { node, from }
    if (node.type.name === GROUP) {
      const widths = displayWidths(node)
      root.widths = node.attrs.widths
      root.columns = []
      node.forEach((col, offset, i) => root.columns!.push({
        node: col, from: from + 1 + offset, blocks: children(col, from + 2 + offset), width: widths[i],
      }))
    }
    roots.push(root)
  })
  let sourceRoot: Root | undefined, sourceColumn: Column | undefined
  let sourceFlow: Block[] = roots
  for (const root of roots) for (const col of root.columns ?? []) {
    if (col.from! + 1 === source.flowStart) { sourceRoot = root; sourceColumn = col; sourceFlow = col.blocks }
  }
  const first = sourceFlow.findIndex((block) => block.from === source.from)
  const moved = sourceFlow.slice(first, first + source.nodes.length)
  if (first < 0 || !moved.length || moved.length !== source.nodes.length
    || moved.some((block, i) => block.node !== source.nodes[i])
    || moved[moved.length - 1].from! + moved[moved.length - 1].node.nodeSize !== source.to
    || (sourceColumn ? sourceColumn.node !== source.flowNode : source.flowNode !== state.doc)) return { error: 'invalid-source' }
  const movingGroup = moved.some((block) => block.node.type.name === GROUP)
  if (movingGroup && (moved.length !== 1 || sourceColumn)) return { error: 'invalid-source' }
  const exhaustsColumn = !!sourceColumn && sourceColumn.blocks
    .filter((_block, i) => i < first || i >= first + moved.length).every(disposable)
  let preview: SnapPlan['columns']

  // Resolve destination references BEFORE deleting anything; token identity disambiguates identical text/nodes.
  let destFlow: Block[] | undefined, before: Block | undefined, pair: Root | undefined, destRoot: Root | undefined
  if (target.kind === 'insert') {
    if (target.pos >= source.from && target.pos <= source.to) return { error: 'no-change' }
    if (target.pos < 0 || target.pos > state.doc.content.size) return { error: 'invalid-target' }
    const $pos = state.doc.resolve(target.pos)
    if ($pos.depth === 0) destFlow = roots
    else if ($pos.parent.type.name === COLUMN) {
      for (const root of roots) for (const col of root.columns ?? []) {
        if (col.from! + 1 === $pos.start()) { destFlow = col.blocks; destRoot = root }
      }
    }
    if (!destFlow) return { error: 'invalid-target' }
    if (movingGroup && destFlow !== roots) return { error: 'nested-layout' }
    before = destFlow.find((block) => block.from === target.pos)
    const end = destFlow === roots ? state.doc.content.size : $pos.end()
    if (!before && target.pos !== end) return { error: 'invalid-target' }
  } else if (target.kind === 'pair') {
    if (movingGroup) return { error: 'nested-layout' }
    pair = roots.find((root) => root.from === target.targetFrom)
    if (!pair || pair.columns) return { error: 'invalid-target' }
    if (moved.includes(pair)) return { error: 'no-change' }
  } else {
    if (movingGroup) return { error: 'nested-layout' }
    destRoot = roots.find((root) => root.from === target.groupPos)
    const cols = destRoot?.columns
    if (!cols || !Number.isInteger(target.visualGap) || target.visualGap < 0 || target.visualGap > cols.length) return { error: 'invalid-target' }
    if (!(exhaustsColumn && sourceRoot === destRoot) && cols.length >= 3) return { error: 'max-columns' }
  }

  sourceFlow.splice(first, moved.length)
  if (target.kind === 'insert') {
    const at = before ? destFlow!.indexOf(before) : destFlow!.length
    destFlow!.splice(at, 0, ...moved)
  } else if (target.kind === 'pair') {
    const rtl = context.rtl
    const newColumn = (blocks: Block[]): Column => ({ node: state.schema.nodes[COLUMN].create(), from: null, blocks, width: 50 })
    const active = (target.side === 'left') !== rtl ? 0 : 1
    const cols = [newColumn([pair!])]
    cols.splice(active, 0, newColumn(moved))
    const group: Root = {
      node: state.schema.nodes[GROUP].create({ widths: equalWidths(2), direction: null }),
      from: null, columns: cols, widths: equalWidths(2),
    }
    roots.splice(roots.indexOf(pair!), 1, group)
    preview = { widths: equalWidths(2), active, rtl, action: 'pair' }
  } else {
    const cols = destRoot!.columns!, rtl = context.groupRTL(target.groupPos)
    const logicalGap = rtl ? cols.length - target.visualGap : target.visualGap
    const reorder = exhaustsColumn && sourceRoot === destRoot
    if (reorder) {
      const original = cols.indexOf(sourceColumn!)
      const at = logicalGap - (original < logicalGap ? 1 : 0)
      if (at === original) return { error: 'no-change' }
      // Restore the source content and move its complete column wrapper/width.
      sourceColumn!.blocks = moved
      cols.splice(original, 1)
      cols.splice(at, 0, sourceColumn!)
      if (validWidths(destRoot!.widths, cols.length)) destRoot!.widths = cols.map((col) => col.width)
      preview = { widths: displayPlannedWidths(destRoot!), active: at, rtl, action: 'reorder' }
    } else {
      const col: Column = {
        node: exhaustsColumn ? sourceColumn!.node : state.schema.nodes[COLUMN].create(),
        from: null, blocks: moved, width: 0,
      }
      cols.splice(logicalGap, 0, col)
      destRoot!.widths = equalWidths(cols.length)
      cols.forEach((column, i) => { column.width = (destRoot!.widths as number[])[i] })
      preview = { widths: equalWidths(cols.length), active: logicalGap, rtl, action: 'add' }
    }
  }

  // Only the source column emptied BY THIS MOVE is eligible for removal.
  if (sourceColumn && sourceRoot?.columns?.includes(sourceColumn)
    && !sourceColumn.blocks.some((block) => moved.includes(block))
    && sourceColumn.blocks.every(disposable)) {
    const cols = sourceRoot.columns
    cols.splice(cols.indexOf(sourceColumn), 1)
    const sum = cols.reduce((total, col) => total + col.width, 0)
    sourceRoot.widths = cols.map((col) => col.width / sum * 100)
  }

  let focus = -1, offset = 0
  const emitted: PMNode[] = []
  const focusBlock = moved[0]
  const emitBlock = (block: Block, pos: number) => { if (block === focusBlock) focus = pos; return block.node }
  for (const root of roots) {
    if (root === focusBlock) focus = offset
    if (!root.columns) {
      emitted.push(emitBlock(root, offset)); offset += root.node.nodeSize
      continue
    }
    const cols = root.columns
    if (cols.length < 2) {
      for (const col of cols) for (const block of col.blocks) {
        emitted.push(emitBlock(block, offset)); offset += block.node.nodeSize
      }
      continue
    }
    if (cols.length > 3) return { error: 'max-columns' }
    let colOffset = offset + 1
    const nodes = cols.map((col) => {
      let blockOffset = colOffset + 1
      const blocks = col.blocks.length ? col.blocks : [{ node: state.schema.nodes.paragraph.create(), from: null }]
      const content = blocks.map((block) => {
        const node = emitBlock(block, blockOffset); blockOffset += node.nodeSize; return node
      })
      const next = col.node.copy(Fragment.fromArray(content))
      colOffset += next.nodeSize
      return next.eq(col.node) ? col.node : next
    })
    const next = root.node.type.create({ ...root.node.attrs, widths: root.widths }, nodes, root.node.marks)
    emitted.push(next.eq(root.node) ? root.node : next)
    offset += next.nodeSize
  }
  if (!emitted.length) emitted.push(state.schema.nodes.paragraph.create())
  const doc = state.doc.copy(Fragment.fromArray(emitted))
  if (!doc.type.validContent(doc.content) || !layoutStructureValid(doc)) return { error: 'invalid-target' }
  try { doc.check() } catch { return { error: 'invalid-target' } }
  if (doc.eq(state.doc)) return { error: 'no-change' }
  if (focus < 0) return { error: 'invalid-source' }
  const extraction = sourceColumn && sourceRoot && target.kind === 'insert'
    && (target.pos === sourceRoot.from || target.pos === sourceRoot.from! + sourceRoot.node.nodeSize)
    ? { side: target.pos === sourceRoot.from ? 'before' as const : 'after' as const,
      remainingWidths: sourceRoot.columns!.length >= 2 ? displayPlannedWidths(sourceRoot)
        : sourceRoot.columns!.length ? [100] : [], rtl: context.groupRTL(sourceRoot.from!) } : undefined
  return { plan: { roots: emitted, focus, columns: preview, extraction } }
}

function displayPlannedWidths(root: Root): number[] {
  return validWidths(root.widths, root.columns!.length) ? root.widths : equalWidths(root.columns!.length)
}

/** Patch only changed spans between unchanged root nodes, from the end backwards. */
export function snapTransaction(state: EditorState, plan: SnapPlan): Transaction | null {
  const old: { node: PMNode; from: number }[] = []
  const positions = new Map<PMNode, { indices: number[]; next: number }>()
  state.doc.forEach((node, from) => {
    let entry = positions.get(node)
    if (!entry) { entry = { indices: [], next: 0 }; positions.set(node, entry) }
    entry.indices.push(old.length)
    old.push({ node, from })
  })
  const patches: { from: number; to: number; nodes: PMNode[] }[] = []
  let oldIndex = 0, from = 0, pending: PMNode[] = []
  for (const node of plan.roots) {
    const entry = positions.get(node)
    while (entry && entry.next < entry.indices.length && entry.indices[entry.next] < oldIndex) entry.next++
    const anchor = entry?.indices[entry.next] ?? -1
    if (anchor < 0) { pending.push(node); continue }
    entry!.next++
    const to = old[anchor].from
    if (from !== to || pending.length) patches.push({ from, to, nodes: pending })
    pending = []; from = to + node.nodeSize; oldIndex = anchor + 1
  }
  if (from !== state.doc.content.size || pending.length) patches.push({ from, to: state.doc.content.size, nodes: pending })
  const tr = structural(state.tr)
  try {
    for (const patch of patches.reverse()) tr.replaceWith(patch.from, patch.to, Fragment.fromArray(patch.nodes))
    // A malformed/stale plan never dispatches a partially fitted replacement.
    if (!tr.doc.content.eq(Fragment.fromArray(plan.roots)) || !layoutStructureValid(tr.doc)) return null
  } catch { return null }
  const node = tr.doc.nodeAt(plan.focus)
  if (node && NodeSelection.isSelectable(node) && (node.isAtom || node.type.name === GROUP)) tr.setSelection(NodeSelection.create(tr.doc, plan.focus))
  else focusIn(tr, plan.focus + 1)
  return tr.scrollIntoView()
}
