import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'

/**
 * A six-dot grip handle that follows the hovered top-level block. Dragging it reuses ProseMirror's own
 * node-drag machinery (view.dragging), so drop cursor, move semantics and undo come for free.
 */
export const DragHandle = Extension.create({
  name: 'dragHandle',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          const host = view.dom.parentElement as HTMLElement | null
          if (!host) return {} // headless editor (import/export): no DOM to attach a handle to
          const handle = document.createElement('div')
          handle.className = 'block-handle'
          // six dots (2 × 3) like Notion's grip
          handle.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' + [3, 7, 11].flatMap((y) => [4, 10].map((x) => '<circle cx="' + x + '" cy="' + y + '" r="1.25"/>')).join('') + '</svg>'
          handle.draggable = true
          handle.style.display = 'none'
          host.append(handle)

          let pos = -1 // doc position of the hovered top-level block

          let timer = 0
          const hide = () => {
            window.clearTimeout(timer)
            handle.style.display = 'none'
            pos = -1
          }
          // The handle sits outside the text column, so the pointer briefly leaves the block on its way.
          const hideSoon = () => {
            window.clearTimeout(timer)
            timer = window.setTimeout(hide, 350)
          }

          const onMove = (e: MouseEvent) => {
            if (!view.editable) return hide() // reader mode: nothing to drag
            if (e.target === handle) return window.clearTimeout(timer)
            window.clearTimeout(timer)
            const hit = view.posAtCoords({ left: e.clientX, top: Math.min(Math.max(e.clientY, 0), innerHeight) })
            if (!hit || !view.dom.contains(e.target as Node)) return hideSoon()
            const $p = view.state.doc.resolve(hit.pos)
            if ($p.depth < 1) return hide()
            const start = $p.before(1)
            const dom = view.nodeDOM(start) as HTMLElement | null
            if (!dom || !(dom as any).getBoundingClientRect) return hide()
            pos = start
            const r = dom.getBoundingClientRect()
            const h = host.getBoundingClientRect()
            const rtl = getComputedStyle(dom).direction === 'rtl'
            const lineH = parseFloat(getComputedStyle(dom).lineHeight) || 28
            handle.style.display = 'flex'
            handle.style.top = `${r.top - h.top + Math.max(0, (lineH - 24) / 2)}px`
            handle.style.left = rtl ? `${r.right - h.left + 4}px` : `${r.left - h.left - 28}px`
          }

          handle.addEventListener('dragstart', (e) => {
            if (pos < 0) return
            const sel = NodeSelection.create(view.state.doc, pos)
            view.dispatch(view.state.tr.setSelection(sel))
            ;(view as any).dragging = { slice: sel.content(), move: true }
            const dom = view.nodeDOM(pos) as HTMLElement
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'copyMove'
              e.dataTransfer.setData('text/plain', ' ')
              e.dataTransfer.setDragImage(dom, 0, 0)
            }
          })
          handle.addEventListener('dragend', () => {
            ;(view as any).dragging = null
            hide()
          })

          host.addEventListener('mousemove', onMove)
          host.addEventListener('mouseleave', hideSoon)
          handle.addEventListener('mouseenter', () => window.clearTimeout(timer))
          handle.addEventListener('mouseleave', hideSoon)
          return {
            update: () => {
              if (pos >= view.state.doc.content.size) hide()
            },
            destroy: () => {
              host.removeEventListener('mousemove', onMove)
              host.removeEventListener('mouseleave', hideSoon)
              handle.remove()
            },
          }
        },
      }),
    ]
  },
})
