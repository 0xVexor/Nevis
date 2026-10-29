import { Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { COLUMN, GROUP, adjacentColumnSelection, ancestor, boundaryKey } from './layoutModel'
import { insideTable } from './layoutEditing'

/** Physical column navigation is independent of the bidi direction of a paragraph inside it. */
export function navigateLayout(view: EditorView, direction: 'left' | 'right' | 'up' | 'down'): { selection: Selection | null } | null {
  const state = view.state
  if (!state.selection.empty || !(state.selection instanceof TextSelection) || insideTable(state)) return null
  const column = ancestor(state.selection.$from, COLUMN), group = ancestor(state.selection.$from, GROUP)
  if (!column || !group || !view.endOfTextblock(direction)) return null
  if (state.selection.$from.depth > column.depth + 1 && !boundaryKey(state, true) && !boundaryKey(state, false)) return null
  const dom = view.nodeDOM(group.pos)
  if (!(dom instanceof HTMLElement)) return null
  if (dom.classList.contains('layout-stacked')) {
    if (direction === 'left' || direction === 'right') return null
    const backwards = direction === 'up'
    if (!boundaryKey(state, backwards)) return null
    return { selection: adjacentColumnSelection(state, backwards) }
  }
  if (direction === 'up' || direction === 'down') {
    const backwards = direction === 'up'
    if (!boundaryKey(state, backwards)) return null
    const edge = group.pos + (backwards ? 0 : group.node.nodeSize)
    return { selection: Selection.findFrom(state.doc.resolve(edge), backwards ? -1 : 1) }
  }
  const rtl = getComputedStyle(dom).direction === 'rtl'
  const delta = (direction === 'left' ? -1 : 1) * (rtl ? -1 : 1)
  const index = state.selection.$from.index(group.depth) + delta
  if (index < 0 || index >= group.node.childCount) {
    const edge = group.pos + (index < 0 ? 0 : group.node.nodeSize)
    return { selection: Selection.findFrom(state.doc.resolve(edge), index < 0 ? -1 : 1) }
  }
  let nextPos = group.pos + 1
  for (let i = 0; i < index; i++) nextPos += group.node.child(i).nodeSize
  const next = view.nodeDOM(nextPos)
  if (!(next instanceof HTMLElement)) return null
  const r = next.getBoundingClientRect(), padding = getComputedStyle(next)
  const x = direction === 'right' ? r.left + (parseFloat(padding.paddingLeft) || 0) + 2
    : r.right - (parseFloat(padding.paddingRight) || 0) - 2
  const caret = view.coordsAtPos(state.selection.head)
  const y = Math.max(r.top + 2, Math.min(r.bottom - 2, (caret.top + caret.bottom) / 2))
  const hit = view.posAtCoords({ left: x, top: y })
  if (hit && ancestor(state.doc.resolve(hit.pos), COLUMN)?.pos === nextPos) {
    const selection = TextSelection.near(state.doc.resolve(hit.pos))
    if (ancestor(selection.$from, COLUMN)?.pos === nextPos) return { selection }
  }
  const leaf = next.querySelector<HTMLElement>('p, h1, h2, h3, h4, h5, h6, pre') ?? next
  const textRTL = getComputedStyle(leaf).direction === 'rtl'
  const enterAtEnd = direction === 'left' ? !textRTL : textRTL
  const edge = nextPos + 1 + (enterAtEnd ? group.node.child(index).content.size : 0)
  const $edge = state.doc.resolve(edge)
  const text = TextSelection.findFrom($edge, enterAtEnd ? -1 : 1, true)
  if (text && ancestor(text.$from, COLUMN)?.pos === nextPos) return { selection: text }
  const atomic = Selection.findFrom($edge, enterAtEnd ? -1 : 1)
  return { selection: atomic && ancestor(atomic.$from, COLUMN)?.pos === nextPos ? atomic : null }
}
