import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import { DOMSerializer, Fragment, Slice } from '@tiptap/pm/model'

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
          handle.innerHTML = '<svg width="18" height="18" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' + [3, 7, 11].flatMap((y) => [4.5, 9.5].map((x) => '<circle cx="' + x + '" cy="' + y + '" r="1.35"/>')).join('') + '</svg>'
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
            if (handle.contains(e.target as Node)) return window.clearTimeout(timer) // also the svg inside it: otherwise the handle hid itself under the pointer
            window.clearTimeout(timer)
            if (!view.dom.contains(e.target as Node)) return hideSoon()
            // the top-level block under the pointer, found from the DOM (tables and other wrapped blocks resolve reliably this way)
            let blockEl = e.target as HTMLElement | null
            while (blockEl && blockEl.parentElement !== view.dom) blockEl = blockEl.parentElement
            let start = -1
            if (blockEl) {
              const inside = view.state.doc.resolve(view.posAtDOM(blockEl, 0))
              start = inside.depth >= 1 ? inside.before(1) : -1
            }
            if (start < 0) {
              const hit = view.posAtCoords({ left: e.clientX, top: Math.min(Math.max(e.clientY, 0), innerHeight) })
              if (!hit) return hideSoon()
              const $p = view.state.doc.resolve(hit.pos)
              if ($p.depth < 1) return hide()
              start = $p.before(1)
            }
            const dom = view.nodeDOM(start) as HTMLElement | null
            if (!dom || !(dom as any).getBoundingClientRect) return hide()
            pos = start
            const r = dom.getBoundingClientRect()
            const h = host.getBoundingClientRect()
            const rtl = getComputedStyle(dom).direction === 'rtl'
            const lineH = parseFloat(getComputedStyle(dom).lineHeight) || 28
            handle.style.display = 'flex'
            handle.classList.toggle('rtl', rtl)
            handle.style.top = `${r.top - h.top + (lineH - 32) / 2}px`
            handle.style.left = rtl ? `${r.right - h.left + 4}px` : `${r.left - h.left - 36}px`
          }

          handle.addEventListener('dragstart', (e) => {
            if (pos < 0 || pos >= view.state.doc.content.size || !view.state.doc.nodeAt(pos)) return (e.preventDefault(), hide())
            const sel = NodeSelection.create(view.state.doc, pos)
            view.dispatch(view.state.tr.setSelection(sel))
            // the whole block, cells and all (a table dragged as just its outline is the failure this guards against)
            const node = view.state.doc.nodeAt(pos)!
            const slice = new Slice(Fragment.from(node), 0, 0)
            // `node` makes the drop remove exactly this block. Without it ProseMirror deletes the *selection*, and for a table that selection has been
            // turned into a cell selection by the tables plugin: deleting it only empties the cells and leaves the outline behind
            ;(view as any).dragging = { slice, move: true, node: sel }
            const dom = view.nodeDOM(pos) as HTMLElement
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move' // a block is moved, never copied: the browser shows the move cursor, not the copy one
              // also hand over the content as text/html: if a drop ever falls back to the clipboard path it still carries everything
              const box = document.createElement('div')
              box.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content))
              e.dataTransfer.setData('text/html', box.innerHTML)
              e.dataTransfer.setData('text/plain', node.textContent || ' ')
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
            update: (v, prev) => {
              // `pos` is only measured on mouse move: after an edit it may point at another block (or nowhere)
              if (v.state.doc !== prev.doc && !v.dragging) hide()
              else if (pos >= v.state.doc.content.size) hide()
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
