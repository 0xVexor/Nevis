import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { COLUMN, GROUP, ancestor, type BlockRange } from './layoutModel'
import { snapKey, wholeSourceColumn, type SnapContext, type SnapFailure, type SnapPlan, type SnapTarget } from './snapModel'
import { t } from '../i18n'

export interface SnapRect {
  left: number
  top: number
  width: number
  height: number
}
export interface SnapDestination {
  target: SnapTarget
  key: string
  label: string
  hit: SnapRect
  rect: SnapRect
  columnRect?: SnapRect
  priority: number
  edgeBands?: { top: number; bottom: number }[]
  pointerDisabled?: boolean
  /** Extra physical ways to leave the source column without traversing a taller sibling. */
  escapeAreas?: SnapRect[]
  kind: 'line' | 'columns' | 'full-width'
  plan?: SnapPlan
  error?: SnapFailure | 'insufficient-width'
}

export function snapContext(view: EditorView): SnapContext {
  const rootRTL = !!view.dom && getComputedStyle(view.dom).direction === 'rtl'
  const groups = new Map<number, boolean>()
  return {
    rtl: rootRTL,
    groupRTL: (pos) => {
      if (!view.dom) return false
      const cached = groups.get(pos)
      if (cached != null) return cached
      const dom = view.nodeDOM(pos)
      const rtl = dom instanceof HTMLElement ? getComputedStyle(dom).direction === 'rtl' : rootRTL
      groups.set(pos, rtl)
      return rtl
    },
  }
}

function domRect(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos)
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
}
const rect = (r: DOMRect): SnapRect => ({ left: r.left, top: r.top, width: r.width, height: r.height })
/** The page margin beside the text, where the grip sits. */
const GUTTER = 52
/** How far into a block (or column) its side-by-side zone reaches. */
const sideZone = (width: number) => Math.max(48, Math.min(150, width * 0.22))
/** A one- or two-line block still gets side targets you can hit, and a preview you can read: at least this tall, centred on it. */
const MIN_TARGET = 44,
  MIN_PREVIEW = 56
const atLeast = (top: number, height: number, min: number) => (height >= min ? { top, height } : { top: top + height / 2 - min / 2, height: min })
export const containsSnapPoint = (r: SnapRect, x: number, y: number, extra = 0) => x >= r.left - extra && x <= r.left + r.width + extra && y >= r.top - extra && y <= r.top + r.height + extra
export const hitsSnapDestination = (destination: SnapDestination, x: number, y: number, extra = 0) =>
  containsSnapPoint(destination.hit, x, y, extra) || !!destination.escapeAreas?.some((r) => containsSnapPoint(r, x, y, extra))

/** User-facing content labels never expose document positions or structural group numbers. */
function blockLabel(node: PMNode, ordinal: number) {
  const text = node.textContent.trim().replace(/\s+/g, ' ').slice(0, 44)
  const names: Record<string, string> = {
    paragraph: 'Text',
    heading: 'Heading',
    image: 'Image',
    table: 'Table',
    databaseEmbed: 'Database',
    drawing: 'Drawing',
    codeBlock: 'Code block',
    taskList: 'Checklist',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    layoutGroup: 'Layout',
  }
  return t('{content} ({n})', { content: text || t(names[node.type.name] ?? 'Block'), n: ordinal })
}

/** Geometry is a disposable snapshot. Rebuild after scroll/resize or content geometry changes. */
export function snapDestinations(view: EditorView, source?: BlockRange): SnapDestination[] {
  const out: SnapDestination[] = []
  const movingColumn = source ? wholeSourceColumn(view.state, source) : null
  let sourceHeight = 0,
    sourcePos = source?.from ?? 0
  for (const node of source?.nodes ?? []) {
    sourceHeight += domRect(view, sourcePos)?.height ?? 0
    sourcePos += node.nodeSize
  }
  const previewHeight = source ? Math.max(40, Math.min(88, sourceHeight)) : 48
  // The strip at the top and bottom of a layout that leaves it. A short layout keeps it thin, so its columns stay reachable.
  const groupEdge = (r: DOMRect) => (r.height < 96 ? Math.min(8, r.height * 0.12) : Math.min(20, r.height * 0.2))
  let ordinal = 0
  const add = (destination: Omit<SnapDestination, 'key'>) => {
    out.push({ ...destination, key: snapKey(destination.target) })
  }
  const flow = (node: PMNode, start: number, bounds: DOMRect, root: boolean) => {
    const blocks: { node: PMNode; pos: number; r: DOMRect; label: string }[] = []
    node.forEach((child, offset) => {
      const pos = start + offset,
        r = domRect(view, pos)
      if (r && r.width > 0 && r.height > 0) blocks.push({ node: child, pos, r, label: blockLabel(child, ++ordinal) })
    })
    for (let i = 0; i <= blocks.length; i++) {
      const previous = blocks[i - 1],
        next = blocks[i]
      const y = root && previous?.node.type.name === GROUP ? previous.r.bottom : next ? next.r.top : previous ? previous.r.bottom : bounds.top + 4
      let top = previous ? previous.r.top + previous.r.height / 2 : bounds.top
      let bottom = next ? next.r.top + next.r.height / 2 : bounds.bottom
      // Root group interiors belong to their columns; only the edge band exits the group.
      if (root && previous?.node.type.name === GROUP) top = previous.r.bottom - groupEdge(previous.r)
      if (root && next?.node.type.name === GROUP) bottom = next.r.top + groupEdge(next.r)
      const pos = next?.pos ?? start + node.content.size
      add({
        target: { kind: 'insert', pos },
        label:
          next?.node.type.name === GROUP
            ? t('Above this layout')
            : previous?.node.type.name === GROUP
              ? t('Below this layout')
              : next
                ? t('Before {content}', { content: next.label })
                : previous
                  ? t('After {content}', { content: previous.label })
                  : t('Move here'),
        // On the page the rows reach into the gutters, where the grip is: dragging straight down the margin always reorders.
        hit: root
          ? { left: bounds.left - GUTTER, top, width: bounds.width + GUTTER * 2, height: Math.max(0, bottom - top) }
          : { left: bounds.left, top, width: bounds.width, height: Math.max(0, bottom - top) },
        rect: { left: bounds.left, top: root ? y : y - 1, width: bounds.width, height: root ? previewHeight : 2 },
        priority: 1,
        kind: root ? 'full-width' : 'line',
        columnRect: root ? undefined : rect(bounds),
        edgeBands: root
          ? [
              ...(previous?.node.type.name === GROUP ? [{ top: previous.r.bottom - groupEdge(previous.r), bottom: previous.r.bottom }] : []),
              ...(next?.node.type.name === GROUP ? [{ top: next.r.top, bottom: next.r.top + groupEdge(next.r) }] : []),
            ]
          : movingColumn
            ? [{ top: y - 5, bottom: y + 5 }]
            : undefined,
      })
    }
    for (const block of blocks) {
      const { r, pos, label } = block
      if (root && block.node.type.name !== GROUP) {
        // Side by side: move the pointer onto the left or right part of the block itself, like snapping a window.
        // The middle and the margins reorder, so an ordinary drag never turns two paragraphs into columns by accident.
        const edge = sideZone(r.width),
          vertical = r.height > MIN_TARGET ? Math.min(6, r.height * 0.2) : 0,
          band = atLeast(r.top + vertical, r.height - vertical * 2, MIN_TARGET)
        for (const side of ['left', 'right'] as const)
          add({
            target: { kind: 'pair', targetFrom: pos, side },
            label: t(side === 'left' ? 'Left of {content}' : 'Right of {content}', { content: label }),
            hit: { left: side === 'left' ? r.left : r.right - edge, top: band.top, width: edge, height: band.height },
            rect: { left: bounds.left, ...atLeast(r.top, r.height, MIN_PREVIEW), width: bounds.width },
            priority: 3,
            kind: 'columns',
          })
      }
      if (block.node.type.name !== GROUP) continue
      if (root) {
        // Beside a layout the margin still reorders: its upper half moves above the layout, its lower half below.
        const middle = r.top + r.height / 2
        const margins = (top: number, bottom: number): SnapRect[] => [
          { left: r.left - GUTTER, top, width: GUTTER, height: Math.max(0, bottom - top) },
          { left: r.right, top, width: GUTTER, height: Math.max(0, bottom - top) },
        ]
        const above = out.find((d) => d.key === snapKey({ kind: 'insert', pos })),
          below = out.find((d) => d.key === snapKey({ kind: 'insert', pos: pos + block.node.nodeSize }))
        if (above) above.escapeAreas = [...(above.escapeAreas ?? []), ...margins(r.top, middle)]
        if (below) below.escapeAreas = [...(below.escapeAreas ?? []), ...margins(middle, r.bottom)]
      }
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) continue
      const body = dom.querySelector<HTMLElement>(':scope > .layout-columns')
      if (!body) continue
      const groupBounds = body.getBoundingClientRect()
      const visual: DOMRect[] = []
      block.node.forEach((col, offset) => {
        const colPos = pos + 1 + offset,
          c = domRect(view, colPos)
        if (c) {
          visual.push(c)
          // A short column still owns the whitespace below it, up to the bottom of its row.
          flow(col, colPos + 1, dom.classList.contains('layout-stacked') ? c : new DOMRect(c.left, groupBounds.top, c.width, Math.max(c.height, groupBounds.height)), false)
        }
      })
      if (dom.classList.contains('layout-stacked') || visual.length !== block.node.childCount) continue
      visual.sort((a, b) => a.left - b.left)
      const reordering = movingColumn?.groupPos === pos
      const inner = atLeast(r.top + groupEdge(r), Math.max(0, r.height - groupEdge(r) * 2), MIN_TARGET)
      const rtl = getComputedStyle(dom).direction === 'rtl'
      const sourceIndex = movingColumn && reordering ? (rtl ? visual.length - 1 - movingColumn.logicalIndex : movingColumn.logicalIndex) : -1
      for (let gap = 0; gap <= visual.length; gap++) {
        const left = visual[gap - 1],
          right = visual[gap]
        const x = left && right ? (left.right + right.left) / 2 : right ? right.left : left.right
        const hitWidth = Math.min(112, (left?.width ?? Infinity) * 0.44, (right?.width ?? Infinity) * 0.44)
        // The outer edges of a layout work like the edges of a block: inside the column, never in the margin.
        const outer = !left ? { left: x, width: sideZone(right.width) } : !right ? { left: x - sideZone(left.width), width: sideZone(left.width) } : { left: x - hitWidth / 2, width: hitWidth }
        // Dragging the last content in a column onto a sibling moves that column to the
        // sibling's position. Tiny insertion bands still allow an explicit content merge.
        const sibling = reordering && gap !== sourceIndex && gap !== sourceIndex + 1 ? visual[gap < sourceIndex ? gap : gap - 1] : null
        add({
          target: { kind: 'column-gap', groupPos: pos, visualGap: gap },
          label:
            gap === 0
              ? t('Left of {content}', { content: label })
              : gap === visual.length
                ? t('Right of {content}', { content: label })
                : t('Between columns {a} and {b} of {content}', { a: gap, b: gap + 1, content: label }),
          hit: { left: sibling ? sibling.left - 12 : outer.left, top: inner.top, width: sibling ? sibling.width + 24 : outer.width, height: inner.height },
          pointerDisabled: reordering && !sibling,
          rect: { left: groupBounds.left, ...atLeast(groupBounds.top, groupBounds.height, MIN_PREVIEW), width: groupBounds.width },
          priority: 3,
          kind: 'columns',
        })
      }
    }
  }
  flow(view.state.doc, 0, view.dom.getBoundingClientRect(), true)
  if (source) {
    const $source = view.state.doc.resolve(source.from)
    const column = ancestor($source, COLUMN),
      group = ancestor($source, GROUP)
    if (column && group) {
      const c = domRect(view, column.pos),
        g = domRect(view, group.pos)
      const s = domRect(view, source.from)
      let first: DOMRect | null = null,
        last: DOMRect | null = null,
        movedBottom = s?.bottom ?? 0
      column.node.forEach((_node, offset) => {
        const pos = column.pos + 1 + offset,
          r = domRect(view, pos)
        if (!r?.height) return
        if (!first) first = r
        last = r
        if (pos >= source.from && pos < source.to) movedBottom = Math.max(movedBottom, r.bottom)
      })
      const before = out.find((d) => d.target.kind === 'insert' && d.target.pos === group.pos)
      const after = out.find((d) => d.target.kind === 'insert' && d.target.pos === group.pos + group.node.nodeSize)
      if (c && g && s && first && last && before && after) {
        const firstRect = first as DOMRect,
          lastRect = last as DOMRect
        before.label = t('Above this layout')
        after.label = t('Below this layout')
        const middle = (s.top + movedBottom) / 2
        const sideAreas = (top: number, bottom: number): SnapRect[] => [
          { left: g.left - 52, top, width: 52, height: Math.max(0, bottom - top) },
          { left: g.right, top, width: 52, height: Math.max(0, bottom - top) },
        ]
        before.escapeAreas = sideAreas(g.top - 24, middle)
        after.escapeAreas = sideAreas(middle, g.bottom + 24)
        // The short source column ends at its CONTENT, not at the bottom of a tall table
        // next to it. Pulling below that content is an explicit full-width extraction.
        if (lastRect.bottom + 8 < g.bottom)
          after.escapeAreas.push({
            left: c.left,
            top: lastRect.bottom + 8,
            width: c.width,
            height: g.bottom - lastRect.bottom - 8,
          })
        before.escapeAreas.push({ left: c.left, top: g.top - 24, width: c.width, height: Math.max(0, firstRect.top - 8 - (g.top - 24)) })
      }
    }
  }
  out.sort((a, b) => a.rect.top - b.rect.top || a.hit.left - b.hit.left || b.priority - a.priority)
  return out
}

/** `columns: false` leaves out every side-by-side choice: the pointer has not moved sideways yet. */
export function chooseSnapDestination(destinations: SnapDestination[], x: number, y: number, previous?: SnapDestination | null, columns = true) {
  // Dropping where the block already is changes nothing: let the pointer fall through to a real choice beneath.
  const allowed = (dest: SnapDestination) => !dest.pointerDisabled && dest.error !== 'no-change' && (columns || dest.kind !== 'columns')
  const priority = (destination: SnapDestination) =>
    destination.escapeAreas?.some((r) => containsSnapPoint(r, x, y)) ? 5 : destination.edgeBands?.some((band) => y >= band.top && y <= band.bottom) ? 4 : destination.priority
  // Targets of short neighbouring blocks overlap a little; the one whose middle is nearest the pointer wins.
  const distance = (dest: SnapDestination) => Math.abs(y - (dest.hit.top + dest.hit.height / 2))
  const hits = destinations.filter((dest) => allowed(dest) && hitsSnapDestination(dest, x, y)).sort((a, b) => priority(b) - priority(a) || distance(a) - distance(b))
  const hit = hits[0]
  // An invalid gap must not silently become a different, destructive operation beneath it.
  if (hit?.error) return hit
  const retained = previous && destinations.find((dest) => dest.key === previous.key && !dest.error && allowed(dest))
  // Crossing from a column interior into an insertion seam is an explicit change of intent.
  // The previous choice holds while the pointer is still on it, unless it is now clearly nearer another one (8px of slack).
  if (
    retained &&
    (!hit || retained.kind === hit.kind) &&
    hitsSnapDestination(retained, x, y, 3) &&
    (!hit || (priority(hit) <= priority(retained) && distance(hit) + 8 >= distance(retained)))
  )
    return retained
  return hit ?? null
}
