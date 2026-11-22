// Adapted from Nevis/spike/tiptap/src/editor/tableResize.ts; widths use SV 4 scalar attributes.
import type { EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { yUndoPluginKey } from '@tiptap/y-tiptap'

const GRAB = 7 // px on each side of a column border that pick it up
const MIN = 56 // narrowest a column can get

type Border = { table: HTMLElement; wrap: HTMLElement; widths: number[]; col: number; x: number }
type Drag = Border & { startX: number; sign: number; max: number; out: number[]; align?: string }

/**
 * Column resizing for every table, left-to-right and right-to-left alike (it answers before the stock plugin).
 * - A border between two columns moves width from one to the other, so the table keeps its size.
 * - Either outside border grows or shrinks its nearest column, never past the page.
 * - A guide line runs the full height of the table while hovering or dragging; double-click a border to reset all widths.
 */
export const TableColumnResize = Extension.create({
  name: 'tableColumnResize',
  priority: 1000,
  addProseMirrorPlugins() {
    let hover: Border | null = null
    let drag: Drag | null = null
    let guide: HTMLDivElement | null = null
    let stopDrag: (() => void) | null = null

    const isRtl = (table: Element) => getComputedStyle(table).direction === 'rtl'

    // The colgroup exposes each logical column even if all cells across a border are merged.
    const measure = (table: HTMLTableElement): number[] => {
      const columns = Array.from(table.querySelectorAll(':scope > colgroup > col'), col => Math.round(col.getBoundingClientRect().width))
      if (columns.length && columns.every(width => width > 0)) return columns
      const rows = Array.from(table.rows)
      const count = rows.reduce((n, r) => Math.max(n, Array.from(r.cells).reduce((s, c) => s + (c.colSpan || 1), 0)), 0)
      const widths: number[] = Array(count).fill(0)
      for (const row of rows) {
        let i = 0
        for (const cell of Array.from(row.cells)) {
          const span = cell.colSpan || 1
          if (span === 1 && !widths[i]) widths[i] = cell.getBoundingClientRect().width
          i += span
        }
      }
      const fallback = table.getBoundingClientRect().width / Math.max(1, count)
      return widths.map((w) => Math.round(w || fallback))
    }

    // Logical borders run from start (0) to end (widths.length).
    const borders = (table: HTMLElement, widths: number[]) => {
      const rect = table.getBoundingClientRect()
      const rtl = isRtl(table)
      const start = rtl ? rect.right : rect.left
      let offset = 0
      return [start, ...widths.map((width, i) => {
        offset += width
        if (i === widths.length - 1) return rtl ? rect.left : rect.right
        return start + (rtl ? -offset : offset)
      })]
    }

    const showGuide = (b: { table: HTMLElement; wrap: HTMLElement; x: number } | null) => {
      if (!b) {
        guide?.remove()
        guide = null
        return
      }
      if (!guide) {
        guide = document.createElement('div')
        guide.className = 'table-col-guide'
        guide.contentEditable = 'false'
      }
      if (guide.parentElement !== b.wrap) b.wrap.append(guide)
      const w = b.wrap.getBoundingClientRect()
      guide.style.left = `${Math.round(b.x - w.left + b.wrap.scrollLeft - 1)}px`
    }

    const clear = (view: EditorView) => {
      hover = null
      showGuide(null)
      view.dom.classList.remove('resize-cursor')
    }

    const borderAt = (target: EventTarget | null, x: number, y: number): Border | null => {
      // the table's end border can be grabbed from just outside it too
      const near = (target as HTMLElement | null)?.closest?.('.tableWrapper') ?? [-GRAB, GRAB].map((d) => document.elementFromPoint(x + d, y)?.closest('.tableWrapper')).find(Boolean)
      const table = near?.querySelector('table') as HTMLTableElement | null
      const wrap = table?.closest<HTMLElement>('.tableWrapper')
      if (!table || !wrap) return null
      const r = table.getBoundingClientRect()
      if (y < r.top || y > r.bottom) return null
      const widths = measure(table)
      const xs = borders(table, widths)
      let best = -1
      xs.forEach((bx, i) => {
        if (Math.abs(bx - x) <= GRAB && (best < 0 || Math.abs(bx - x) < Math.abs(xs[best]! - x))) best = i
      })
      return best < 0 ? null : { table, wrap, widths, col: best, x: xs[best]! }
    }

    const apply = (table: HTMLElement, wrap: HTMLElement, widths: number[]) => {
      const cols = table.querySelectorAll<HTMLElement>('colgroup col')
      widths.forEach((w, i) => cols[i] && (cols[i].style.width = `${w}px`))
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`
      table.style.minWidth = ''
      wrap.setAttribute('data-fixed-cols', '')
    }

    // Write `widths` (null: back to automatic) into every cell of the table that contains `dom`.
    const save = (view: EditorView, dom: HTMLElement, widths: number[] | null, outer = false, align?: string) => {
      const body = dom.querySelector('tbody')
      if (!body || !view.dom.contains(body)) return
      const $pos = view.state.doc.resolve(view.posAtDOM(body, 0))
      let depth = $pos.depth
      while (depth > 0 && $pos.node(depth).type.name !== 'table') depth--
      if (depth <= 0) return
      const table = $pos.node(depth),
        start = $pos.start(depth),
        map = TableMap.get(table)
      const tr = view.state.tr
      if (outer) tr.setNodeMarkup($pos.before(depth), undefined, { ...table.attrs, tableWidth: 0, ...(align ? { tableAlign: align } : {}) })
      const done = new Set<number>()
      for (const cellPos of map.map) {
        if (done.has(cellPos)) continue
        done.add(cellPos)
        const cell = table.nodeAt(cellPos)
        if (!cell) continue
        const attrs = cell.attrs
        const first = map.colCount(cellPos)
        const colwidth = widths ? Array.from({ length: attrs.colspan }, (_, i) => widths[first + i]) : null
        tr.setNodeMarkup(start + cellPos, null, { ...attrs, colwidthJson: colwidth ? JSON.stringify(colwidth) : '' })
      }
      if (tr.docChanged) {
        const undo = yUndoPluginKey.getState(view.state)?.undoManager
        undo?.stopCapturing()
        view.dispatch(tr)
        undo?.stopCapturing()
      }
    }

    return [
      new Plugin({
        view: () => ({ destroy() { stopDrag?.(); guide?.remove() } }),
        props: {
          handleDOMEvents: {
            mousemove(view, e) {
              if (!view.editable || drag) return !!drag
              const b = borderAt(e.target, e.clientX, e.clientY)
              if (!b) {
                if (hover) clear(view)
                return false
              }
              hover = b
              view.dom.classList.add('resize-cursor')
              showGuide(b)
              return true
            },
            mouseup: () => !!drag,
            mouseleave(view) {
              if (!drag) clear(view)
              return false
            },
            dblclick(view, e) {
              const b = view.editable ? borderAt(e.target, e.clientX, e.clientY) : null
              if (!b) return false
              e.preventDefault()
              const { table } = b
              clear(view)
              save(view, table, null)
              return true
            },
            mousedown(view, e) {
              if (!view.editable || e.button !== 0) return false
              const b = borderAt(e.target, e.clientX, e.clientY)
              if (!b) return false
              e.preventDefault()
              if (e.detail > 1) return true // the second press of a double-click: dblclick resets
              hover = b
              const wrap = b.wrap
              // the table may grow up to the space its block has (the frame's parent), never past it
              const room = (wrap.parentElement?.clientWidth ?? wrap.clientWidth) - 2
              const outer = b.col === 0 || b.col === b.widths.length
              const physicalLeft = (b.col === 0) !== isRtl(b.table)
              const tableRect = b.table.getBoundingClientRect(), parentRect = wrap.parentElement?.getBoundingClientRect()
              const oppositeAtEdge = parentRect && Math.abs(physicalLeft ? tableRect.right - parentRect.right : tableRect.left - parentRect.left) < 4
              const align = outer && oppositeAtEdge ? (physicalLeft ? 'right' : 'left') : undefined
              const savedWidth = wrap.style.width
              const savedAlign = wrap.dataset.align ?? ''
              const fixed = wrap.hasAttribute('data-fixed-cols')
              const tableStyle = b.table.style.cssText
              const columns = Array.from(b.table.querySelectorAll<HTMLElement>('colgroup col'), column => [column, column.style.width] as const)
              drag = { ...b, align, startX: e.clientX, sign: isRtl(b.table) ? -1 : 1, max: Math.max(room, b.widths.reduce((a, c) => a + c, 0)), out: b.widths }
              const win = view.dom.ownerDocument.defaultView!
              const originalDoc = view.state.doc
              const move = (ev: MouseEvent) => {
                const d = drag
                if (!d) return
                if (view.state.doc !== originalDoc || !d.table.isConnected || !ev.buttons) return finish()
                const delta = Math.round((ev.clientX - d.startX) * d.sign)
                const w = d.widths.slice()
                if (!outer) {
                  const prev = d.col - 1
                  const pair = w[prev]! + w[d.col]!
                  if (pair < MIN * 2) return
                  w[prev] = Math.min(pair - MIN, Math.max(MIN, w[prev]! + delta))
                  w[d.col] = pair - w[prev]!
                } else {
                  const neighbor = d.col === 0 ? 0 : w.length - 1
                  const others = w.reduce((sum, width) => sum + width, 0) - w[neighbor]!
                  w[neighbor] = Math.min(d.max - others, Math.max(MIN, w[neighbor]! + (d.col === 0 ? -delta : delta)))
                  wrap.style.width = ''
                  if (d.align) wrap.dataset.align = d.align
                }
                d.out = w
                apply(d.table, d.wrap, w)
                showGuide({ table: d.table, wrap: d.wrap, x: borders(d.table, w)[d.col]! })
              }
              const finish = () => {
                win.removeEventListener('mouseup', finish)
                win.removeEventListener('mousemove', move)
                const d = drag
                drag = null
                stopDrag = null
                clear(view)
                if (!d || view.state.doc !== originalDoc) return
                if (d.out.some((w, i) => w !== d.widths[i])) save(view, d.table, d.out, outer, d.align)
                else {
                  wrap.style.width = savedWidth
                  wrap.dataset.align = savedAlign
                  wrap.toggleAttribute('data-fixed-cols', fixed)
                  d.table.style.cssText = tableStyle
                  for (const [column, width] of columns) column.style.width = width
                }
              }
              stopDrag = () => {
                win.removeEventListener('mouseup', finish)
                win.removeEventListener('mousemove', move)
                drag = null
                stopDrag = null
              }
              win.addEventListener('mouseup', finish)
              win.addEventListener('mousemove', move)
              return true
            },
          },
        },
      }),
    ]
  },
})
