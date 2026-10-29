import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState, Selection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'
import { GROUP, crossesColumns, flattenLayouts, layoutStructureValid, structural } from './layoutModel'

interface FlowEdit { from: number; to: number; content: Fragment; column: boolean }

/** Delete each selected flow independently. Column wrappers and unselected text never join. */
export function editAcrossColumns(state: EditorState, replacement?: string | Slice, split = false): Transaction | null {
  if (!crossesColumns(state)) return null
  const { from, to } = state.selection
  const flows: FlowEdit[] = []
  let run: { from: number; to: number; nodes: PMNode[] } | null = null
  const flush = () => {
    if (run) flows.push({ from: run.from, to: run.to, content: Fragment.fromArray(run.nodes), column: false })
    run = null
  }
  state.doc.forEach((node, pos) => {
    if (node.type.name === GROUP) {
      flush()
      node.forEach((col, offset) => {
        const start = pos + 2 + offset, end = start + col.content.size
        if (from < end && to > start) flows.push({ from: start, to: end, content: col.content, column: true })
      })
    } else if (from < pos + node.nodeSize && to > pos) {
      if (!run) run = { from: pos, to: pos, nodes: [] }
      run.nodes.push(node); run.to = pos + node.nodeSize
    } else flush()
  })
  flush()
  if (!flows.length) return null
  const tr = structural(state.tr)
  let focusFlow = flows[0].from, focusOffset = 0
  try {
    for (const flow of [...flows].reverse()) {
      const a = Math.max(from, flow.from) - flow.from, b = Math.min(to, flow.to) - flow.from
      let content: Fragment, offset = 0
      if (a === 0 && b === flow.content.size) {
        content = flow.column ? Fragment.from(state.schema.nodes.paragraph.create()) : Fragment.empty
        offset = flow.column ? 1 : 0
      } else {
        // The temporary document confines PM's replace fitting to THIS flow, including lists/tables.
        const doc = state.schema.topNodeType.create(null, flow.content)
        const local = EditorState.create({ doc }).tr.delete(a, b)
        local.doc.check()
        content = local.doc.content
        offset = local.mapping.map(a, -1)
      }
      tr.replaceWith(flow.from, flow.to, content)
      if (flow === flows[0]) { focusFlow = flow.from; focusOffset = offset }
    }
    let at = tr.mapping.map(focusFlow, -1) + focusOffset
    at = Math.max(0, Math.min(at, tr.doc.content.size))
    // Replacing a root block must not insert the replacement into an unrelated following group.
    if ((replacement != null || split) && tr.doc.resolve(at).depth === 0) {
      tr.insert(at, state.schema.nodes.paragraph.create())
      at++
    }
    const $at = tr.doc.resolve(at)
    const caret = TextSelection.findFrom($at, 1, true) ?? TextSelection.findFrom($at, -1, true) ?? Selection.near($at)
    tr.setSelection(caret)
    if (typeof replacement === 'string') tr.insertText(replacement)
    else if (replacement) tr.replaceSelection(new Slice(flattenLayouts(replacement.content), 0, 0))
    if (split && tr.selection.$from.parent.isTextblock && canSplit(tr.doc, tr.selection.from)) {
      const pos = tr.selection.from
      tr.split(pos)
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)))
    }
    tr.doc.check()
    if (!layoutStructureValid(tr.doc)) return null
    return tr.scrollIntoView()
  } catch { return null }
}

/** Preserve partial text at both ends rather than copying whole touched paragraphs. */
export function crossColumnClipboard(state: EditorState): Slice {
  return new Slice(flattenLayouts(state.selection.content().content), 0, 0)
}

export function insideTable(state: EditorState): boolean {
  return ['table', 'tableCell', 'tableHeader'].some((name) => {
    for (let d = state.selection.$from.depth; d > 0; d--) if (state.selection.$from.node(d).type.name === name) return true
    return false
  })
}
