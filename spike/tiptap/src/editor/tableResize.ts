import type { EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'

const GRAB = 7 // px on each side of a column border that pick it up
const MIN = 56 // narrowest a column can get

type Border = { table: HTMLElement; wrap: HTMLElement; widths: number[]; col: number; x: number }
type Drag = Border & { startX: number; sign: number; max: number; out: number[] }

/**
 * Column resizing for every table, left-to-right and right-to-left alike (it answers before the stock plugin).
 * - A border between two columns moves width from one to the other, so the table keeps its size.
 * - The table's end border grows or shrinks the last column, never past the page.
 * - A guide line runs the full height of the table while hovering or dragging; double-click a border to reset all widths.
 */
export const TableColumnResize = Extension.create({
  name: 'tableColumnResize',
  priority: 1000,
  addProseMirrorPlugins() {
    let hover: Border | null = null
    let drag: Drag | null = null
    let guide: HTMLDivElement | null = null

    const isRtl = (table: Element) => getComputedStyle(table).direction === 'rtl'

    // Rendered width of every logical column, read from cells that span a single column.
    const measure = (table: HTMLTableElement): number[] => {
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

    // Screen x of the border after each logical column (the right edge in LTR, the left edge in RTL).
    const borders = (table: HTMLElement, widths: number[]) => {
      const r = table.getBoundingClientRect()
      const rtl = isRtl(table)
      let acc = 0
      return widths.map((w) => {
        acc += w
        return rtl ? r.right - acc : r.left + acc
      })
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
        if (Math.abs(bx - x) <= GRAB && (best < 0 || Math.abs(bx - x) < Math.abs(xs[best] - x))) best = i
      })
      return best < 0 ? null : { table, wrap, widths, col: best, x: xs[best] }
    }

    const apply = (table: HTMLElement, wrap: HTMLElement, widths: number[]) => {
      const cols = table.querySelectorAll<HTMLElement>('colgroup col')
      widths.forEach((w, i) => cols[i] && (cols[i].style.width = `${w}px`))
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`
      table.style.minWidth = ''
      wrap.setAttribute('data-fixed-cols', '')
    }

    // Write `widths` (null: back to automatic) into every cell of the table that contains `dom`.
    const save = (view: EditorView, dom: HTMLElement, widths: number[] | null) => {
      const $pos = view.state.doc.resolve(view.posAtDOM(dom, 0))
      let depth = $pos.depth
      while (depth > 0 && $pos.node(depth).type.name !== 'table') depth--
      if (depth <= 0) return
      const table = $pos.node(depth),
        start = $pos.start(depth),
        map = TableMap.get(table)
      const tr = view.state.tr
      const done = new Set<number>()
      for (const cellPos of map.map) {
        if (done.has(cellPos)) continue
        done.add(cellPos)
        const attrs = table.nodeAt(cellPos)!.attrs
        const first = map.colCount(cellPos)
        const colwidth = widths ? Array.from({ length: attrs.colspan }, (_, i) => widths[first + i]) : null
        tr.setNodeMarkup(start + cellPos, null, { ...attrs, colwidth })
      }
      if (tr.docChanged) view.dispatch(tr)
    }

    return [
      new Plugin({
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
              // the stock view keeps the last pixel widths on <col>; drop them so the table spreads evenly again
              table.querySelectorAll<HTMLElement>('colgroup col').forEach((col) => (col.style.width = ''))
              table.style.width = ''
              table.closest('.tableWrapper')?.removeAttribute('data-fixed-cols')
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
              drag = { ...b, startX: e.clientX, sign: isRtl(b.table) ? -1 : 1, max: Math.max(room, b.widths.reduce((a, c) => a + c, 0)), out: b.widths }
              const win = view.dom.ownerDocument.defaultView!
              const move = (ev: MouseEvent) => {
                const d = drag
                if (!d) return
                if (!ev.buttons) return finish()
                const delta = Math.round((ev.clientX - d.startX) * d.sign)
                const w = d.widths.slice()
                if (d.col < w.length - 1) {
                  // inner border: trade width with the neighbour, both keep the minimum
                  const pair = w[d.col] + w[d.col + 1]
                  w[d.col] = Math.min(pair - MIN, Math.max(MIN, w[d.col] + delta))
                  w[d.col + 1] = pair - w[d.col]
                } else {
                  const others = w.reduce((a, c) => a + c, 0) - w[d.col]
                  w[d.col] = Math.min(d.max - others, Math.max(MIN, w[d.col] + delta))
                }
                d.out = w
                apply(d.table, d.wrap, w)
                showGuide({ table: d.table, wrap: d.wrap, x: borders(d.table, w)[d.col] })
              }
              const finish = () => {
                win.removeEventListener('mouseup', finish)
                win.removeEventListener('mousemove', move)
                const d = drag
                drag = null
                clear(view)
                if (d && d.out.some((w, i) => w !== d.widths[i])) save(view, d.table, d.out)
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
