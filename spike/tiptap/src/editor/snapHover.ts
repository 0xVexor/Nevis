import type { EditorView } from '@tiptap/pm/view'
import { COLUMN, GROUP, flow } from './layoutModel'

const contains = (r: DOMRect, x: number, y: number) => r.width > 0 && r.height > 0
  && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/** Resolve a NodeView's outer block, including chrome outside its contentDOM. */
export function snapBlockAtElement(view: EditorView, element: Element): number | null {
  let child: Element | null = element
  while (child && child !== view.dom) {
    if (child.parentElement === view.dom || child.parentElement?.matches('[data-type="layout-column"]')) break
    child = child.parentElement
  }
  if (!child || child === view.dom) return null
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(child, 0)), stream = flow($pos)
    const pos = $pos.depth > stream.depth ? $pos.before(stream.depth + 1) : $pos.pos
    if (view.nodeDOM(pos) === child) return pos
  } catch { /* Noneditable chrome may map to a neighboring boundary. Compare outer DOM identity. */ }
  let match: number | null = null
  view.state.doc.descendants((node, pos, parent) => {
    if (match != null) return false
    if ((parent?.type.name === 'doc' || parent?.type.name === COLUMN) && view.nodeDOM(pos) === child) { match = pos; return false }
    return node.type.name === GROUP || node.type.name === COLUMN
  })
  return match
}

/** Resolve page blocks geometrically; nested controls and gutter DOM must not change ownership. */
export function hoveredSnapBlock(view: EditorView, x: number, y: number, previous: number): number | null {
  const editor = view.dom.getBoundingClientRect()
  if (x < editor.left - 52 || x > editor.right + 52 || y < editor.top - 8 || y > editor.bottom + 8) return null
  const hitElement = view.dom.ownerDocument.elementFromPoint(x, y)
  // A popup, toolbar or empty space outside the editor cannot own a block hover.
  if (!hitElement || !view.dom.contains(hitElement)) return null
  const direct = hitElement && view.dom.contains(hitElement) ? snapBlockAtElement(view, hitElement) : null
  if (hitElement?.closest('[data-layout-drag-surface]') && direct != null) return direct
  const old = previous >= 0 ? view.nodeDOM(previous) : null
  if (old instanceof HTMLElement) {
    const r = old.getBoundingClientRect()
    const group = view.state.doc.nodeAt(previous)?.type.name === GROUP
    if ((direct == null || direct === previous) && contains(r, x, y)
      && (!group || y < r.top + 8)) return previous
  }
  if (direct != null && view.state.doc.nodeAt(direct)?.type.name !== GROUP) {
    const dom = view.nodeDOM(direct)
    return dom instanceof HTMLElement && contains(dom.getBoundingClientRect(), x, y) ? direct : null
  }
  let nearest: { pos: number; dom: HTMLElement } | null = null
  // Let the editor locate the root first; avoid scanning a long document on every row change.
  const hit = view.posAtCoords({ left: Math.max(editor.left + 1, Math.min(editor.right - 1, x)), top: y })
  if (hit) {
    const resolved = view.state.doc.resolve(hit.pos)
    const pos = resolved.depth ? resolved.before(1) : resolved.pos === view.state.doc.content.size
      ? resolved.pos - (resolved.nodeBefore?.nodeSize ?? 0) : resolved.pos
    const dom = view.nodeDOM(pos)
    if (dom instanceof HTMLElement) {
      const r = dom.getBoundingClientRect()
      if (contains(r, x, y)) nearest = { pos, dom }
    }
  }
  if (!nearest) view.state.doc.forEach((_node, pos) => {
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    const r = dom.getBoundingClientRect()
    if (contains(r, x, y) && !nearest) nearest = { pos, dom }
  })
  if (!nearest) return null
  const root: { pos: number; dom: HTMLElement } = nearest
  const node = view.state.doc.nodeAt(root.pos)!
  if (node.type.name !== GROUP) return root.pos
  const r = root.dom.getBoundingClientRect()
  // A whole-group grip only belongs to the deliberate header strip.
  if (y >= r.top && y < r.top + 8) return root.pos
  let column: { pos: number } | null = null
  node.forEach((_col, offset) => {
    const pos = root.pos + 1 + offset, dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    const c = dom.getBoundingClientRect()
    if (contains(c, x, y) && !column) column = { pos }
  })
  if (!column) return null
  const chosen: { pos: number } = column
  const col = view.state.doc.nodeAt(chosen.pos)!
  let row: { pos: number } | null = null
  col.forEach((_block, offset) => {
    const pos = chosen.pos + 1 + offset, dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    const b = dom.getBoundingClientRect()
    if (contains(b, x, y) && !row) row = { pos }
  })
  return row ? (row as { pos: number }).pos : null
}
