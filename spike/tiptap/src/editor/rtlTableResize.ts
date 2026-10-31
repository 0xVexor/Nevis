import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'

const HANDLE = 5
const MIN = 40

/**
 * Column resizing for right-to-left tables. The stock plugin assumes the first column is on the left: in a RTL table it
 * grabs the wrong neighbour and grows the column the wrong way when you drag. This plugin takes over for tables whose
 * direction is rtl (it sits before the stock one and answers the same mouse events); left-to-right tables are left to it.
 */
export const RtlTableResize = Extension.create({
  name: 'rtlTableResize',
  priority: 1000,
  addProseMirrorPlugins() {
    let active: { cell: HTMLElement; col: number } | null = null
    let drag: { startX: number; startWidth: number; col: number; table: HTMLElement; cell: HTMLElement } | null = null
    let bar: HTMLDivElement | null = null

    const rtl = (table: Element | null) => !!table && getComputedStyle(table).direction === 'rtl'
    // the logical column whose END edge (the left edge, in a RTL table) is at this pointer, if any
    const edgeColumn = (cell: HTMLElement, x: number) => {
      const row = cell.parentElement as HTMLTableRowElement
      const cells = Array.from(row.children) as HTMLElement[]
      const r = cell.getBoundingClientRect()
      const span = (c: HTMLElement) => Number((c as HTMLTableCellElement).colSpan || 1)
      const index = (c: HTMLElement) => cells.slice(0, cells.indexOf(c)).reduce((n, o) => n + span(o), 0)
      if (x - r.left <= HANDLE) return index(cell) + span(cell) - 1
      if (r.right - x <= HANDLE) { const i = index(cell); return i > 0 ? i - 1 : -1 }
      return -1
    }
    const showBar = (table: HTMLElement, x: number | null) => {
      const wrap = table.closest<HTMLElement>('.tableWrapper')
      if (!wrap || x == null) { bar?.remove(); bar = null; return }
      if (!bar) { bar = document.createElement('div'); bar.className = 'column-resize-handle rtl-resize-handle'; bar.contentEditable = 'false' }
      if (bar.parentElement !== wrap) wrap.append(bar)
      const w = wrap.getBoundingClientRect()
      bar.style.cssText = `position:absolute;top:0;bottom:0;width:3px;left:${x - w.left + wrap.scrollLeft - 1}px;right:auto;background:var(--accent);pointer-events:none;z-index:3`
    }
    const clear = (view: any) => { active = null; showBar(document.body, null); view.dom.classList.remove('resize-cursor') }
    const colEl = (table: HTMLElement, col: number) => table.querySelectorAll('colgroup col')[col] as HTMLElement | undefined

    return [new Plugin({
      props: {
        handleDOMEvents: {
          mousemove(view, e) {
            if (!view.editable || drag) return false
            const cell = (e.target as HTMLElement).closest?.('td, th') as HTMLElement | null
            const table = cell?.closest('table') as HTMLElement | null
            if (!cell || !table || !rtl(table)) { if (active) clear(view); return false }
            const col = edgeColumn(cell, e.clientX)
            if (col < 0) { if (active) clear(view); return false }
            active = { cell, col }
            view.dom.classList.add('resize-cursor')
            const r = cell.getBoundingClientRect()
            showBar(table, e.clientX - r.left <= HANDLE ? r.left : r.right)
            return true
          },
          mouseleave(view) { if (!drag) clear(view); return false },
          mousedown(view, e) {
            if (!view.editable || !active || e.button !== 0) return false
            const table = active.cell.closest('table') as HTMLElement
            const first = Array.from(table.querySelectorAll('tr:first-child > *')) as HTMLElement[]
            // measure the real width of that column from the first row (spans are rare there)
            let acc = 0, startWidth = 0
            for (const c of first) { const span = Number((c as HTMLTableCellElement).colSpan || 1); if (active.col < acc + span) { startWidth = c.getBoundingClientRect().width / span; break } acc += span }
            drag = { startX: e.clientX, startWidth, col: active.col, table, cell: active.cell }
            const win = view.dom.ownerDocument.defaultView!
            const width = (ev: MouseEvent) => Math.max(MIN, Math.round(drag!.startWidth + (drag!.startX - ev.clientX))) // dragging left grows a RTL column
            const move = (ev: MouseEvent) => {
              if (!drag) return
              if (!ev.buttons) return finish(ev)
              const w = width(ev)
              const col = colEl(drag.table, drag.col)
              if (col) col.style.width = `${w}px`
              const r = drag.cell.getBoundingClientRect()
              showBar(drag.table, r.left)
            }
            const finish = (ev: MouseEvent) => {
              win.removeEventListener('mouseup', finish); win.removeEventListener('mousemove', move)
              if (!drag) return
              const w = width(ev), d = drag
              drag = null
              const pos = view.posAtDOM(d.cell, 0)
              const $pos = view.state.doc.resolve(pos)
              let depth = $pos.depth
              while (depth > 0 && $pos.node(depth).type.name !== 'table') depth--
              if (depth > 0) {
                const table = $pos.node(depth), start = $pos.start(depth), map = TableMap.get(table)
                const tr = view.state.tr
                for (let row = 0; row < map.height; row++) {
                  const index = row * map.width + d.col
                  if (row && map.map[index] === map.map[index - map.width]) continue
                  const cellPos = map.map[index], attrs = table.nodeAt(cellPos)!.attrs
                  const i = attrs.colspan === 1 ? 0 : d.col - map.colCount(cellPos)
                  if (attrs.colwidth && attrs.colwidth[i] === w) continue
                  const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array(attrs.colspan).fill(0)
                  colwidth[i] = w
                  tr.setNodeMarkup(start + cellPos, null, { ...attrs, colwidth })
                }
                if (tr.docChanged) view.dispatch(tr)
              }
              clear(view)
            }
            win.addEventListener('mouseup', finish); win.addEventListener('mousemove', move)
            e.preventDefault()
            return true
          },
        },
      },
    })]
  },
})
