import { Extension } from '@tiptap/core'
import { Plugin, NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { GROUP, COLUMN, blockRange, flow, moveBlocks, type BlockRange } from './layoutModel'
import { LAYOUT_CANCEL } from './layout'
import { t } from '../i18n'

const MIME = 'application/x-nevis-block-move'
let active: { view: EditorView; range: BlockRange; doc: EditorView['state']['doc'] } | null = null

/** One grip for root blocks, layout groups and the direct blocks of a column. */
export const DragHandle = Extension.create({
  name: 'dragHandle',
  priority: 1050,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        // Reject native block payloads from older windows; current grips use local pointer movement.
        handleDrop: (_view, event) => event.dataTransfer?.types.includes(MIME) ?? false,
      },
      view(view) {
        const host = view.dom.parentElement
        if (!host) return {}
        const handle = document.createElement('button')
        handle.type = 'button'
        handle.className = 'block-handle'
        handle.setAttribute('aria-label', t('Move block'))
        handle.title = t('Drag to move. Click for column destinations.')
        handle.innerHTML = '<svg width="18" height="18" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' + [3, 7, 11].flatMap((y) => [4.5, 9.5].map((x) => `<circle cx="${x}" cy="${y}" r="1.35"/>`)).join('') + '</svg>'
        handle.draggable = false
        handle.style.display = 'none'
        host.append(handle)
        const marker = document.createElement('div')
        marker.className = 'layout-drop-indicator'
        marker.style.display = 'none'
        document.body.append(marker)
        let pos = -1, timer = 0, target: number | null = null, frame = 0
        let cursor: { x: number; y: number } | null = null
        let pointer: { id: number; x: number; y: number; pos: number; started: boolean } | null = null
        let suppressClick = false
        const preview = document.createElement('div')
        preview.className = 'layout-drag-preview'
        preview.style.display = 'none'
        document.body.append(preview)
        const release = () => {
          const id = pointer?.id
          pointer = null
          if (id != null) {
            try { if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id) } catch { /* capture may already be released */ }
          }
        }
        const hide = () => { clearTimeout(timer); handle.style.display = 'none'; pos = -1 }
        const hideSoon = () => { clearTimeout(timer); timer = window.setTimeout(hide, 350) }
        const cancel = () => {
          if (active?.view === view) active = null
          release()
          preview.style.display = 'none'
          marker.style.display = 'none'; target = null; cursor = null
          cancelAnimationFrame(frame); frame = 0
          view.dom.classList.remove('layout-dragging')
          hide()
          window.setTimeout(() => { suppressClick = false }, 0)
        }
        const hoveredBlock = (el: HTMLElement, y: number) => {
          const group = el.closest<HTMLElement>('.layout-group')
          if (group && y <= group.getBoundingClientRect().top + 8) return group
          const column = el.closest<HTMLElement>('[data-type="layout-column"]')
          if (column) {
            if (el !== column) {
              let child = el
              while (child.parentElement && child.parentElement !== column) child = child.parentElement
              return child
            }
            // Moving through the grip gutter must keep targeting the row, not switch to the whole group.
            let nearest: HTMLElement | null = null, distance = Infinity
            for (const child of Array.from(column.children) as HTMLElement[]) {
              const rect = child.getBoundingClientRect()
              const delta = Math.max(rect.top - y, y - rect.bottom, 0)
              if (delta < distance) { nearest = child; distance = delta }
            }
            return nearest
          }
          let block: HTMLElement | null = el
          while (block && block.parentElement !== view.dom && !block.parentElement?.matches('[data-type="layout-column"]')) block = block.parentElement
          return block
        }
        const blockPos = (el: HTMLElement) => {
          const resolved = view.state.doc.resolve(view.posAtDOM(el, 0))
          const f = flow(resolved)
          if (resolved.depth > f.depth) return resolved.before(f.depth + 1)
          // Atomic blocks have no content position: posAtDOM points at their outer boundary.
          return resolved.nodeAfter && view.nodeDOM(resolved.pos) === el ? resolved.pos : -1
        }
        const onMove = (e: MouseEvent) => {
          if (!view.editable || view.composing || active || pointer) return
          if (handle.contains(e.target as globalThis.Node)) { clearTimeout(timer); return }
          if (!view.dom.contains(e.target as globalThis.Node)) return hideSoon()
          if ((e.target as HTMLElement).closest('.layout-resizer, input, textarea, canvas, .db-embed')) return hideSoon()
          clearTimeout(timer)
          const block = hoveredBlock(e.target as HTMLElement, e.clientY)
          if (!block || block === view.dom) return hide()
          const start = blockPos(block)
          if (start < 0) return hide()
          const dom = view.nodeDOM(start) as HTMLElement | null
          if (!dom?.getBoundingClientRect) return hide()
          pos = start
          const r = dom.getBoundingClientRect(), h = host.getBoundingClientRect()
          const column = dom.closest<HTMLElement>('[data-type="layout-column"]')
          const inColumn = !!column
          const rtl = getComputedStyle(dom.closest('.layout-group') || dom).direction === 'rtl'
          const gap = inColumn ? 0 : 16
          handle.style.setProperty('--block-handle-gap', `${gap}px`)
          handle.style.display = 'flex'
          handle.classList.toggle('rtl', rtl)
          handle.classList.toggle('layout-block-grip', inColumn)
          handle.style.top = `${r.top - h.top}px`
          // Column grips live in the column's reserved gutter, away from the resize separator.
          if (column) {
            const c = column.getBoundingClientRect()
            handle.style.left = `${rtl ? c.right - h.left - 26 : c.left - h.left + 2}px`
          } else handle.style.left = rtl ? `${r.right - h.left + gap}px` : `${r.left - h.left - 32 - gap}px`
          handle.setAttribute('aria-label', t(view.state.doc.nodeAt(pos)?.type.name === GROUP ? 'Move layout' : 'Move block'))
        }
        const locate = (x: number, y: number) => {
          target = null; marker.style.display = 'none'
          if (active?.view !== view || active.doc !== view.state.doc || !view.editable) return
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          if (!el || !view.dom.contains(el)) return
          const col = el.closest<HTMLElement>('[data-type="layout-column"]')
          const movingGroup = active.range.nodes.some((n) => n.type.name === GROUP)
          const groupEl = el.closest<HTMLElement>('.layout-group')
          if (movingGroup && groupEl) {
            const rect = groupEl.getBoundingClientRect()
            if (col || y > rect.top + 8 && y < rect.bottom - 8) return
          }
          let container: HTMLElement = view.dom
          let start = 0
          // Group movement can only target root boundaries.
          if (col && !movingGroup) {
            container = col
            const resolved = view.state.doc.resolve(view.posAtDOM(col, 0))
            const f = flow(resolved)
            if (f.node.type.name !== COLUMN) return
            start = f.start
          }
          const children = [...container.children] as HTMLElement[]
          let at = start, line = container.getBoundingClientRect().top
          for (const child of children) {
            const r = child.getBoundingClientRect()
            if (y < r.top + r.height / 2) { line = r.top; break }
            const p = blockPos(child), node = p >= 0 ? view.state.doc.nodeAt(p) : null
            if (node) at = p + node.nodeSize
            line = r.bottom
          }
          if (at >= active.range.from && at <= active.range.to) return
          const $at = view.state.doc.resolve(at)
          if ($at.depth !== flow($at).depth) return
          target = at
          const r = container.getBoundingClientRect()
          marker.style.cssText = `display:block;position:fixed;left:${r.left}px;top:${line - 1}px;width:${r.width}px`
        }
        const scroll = () => {
          frame = 0
          if (active?.view !== view || !cursor) return
          const sc = view.dom.closest<HTMLElement>('.scroller')
          if (sc) {
            const r = sc.getBoundingClientRect(), edge = 48
            const speed = cursor.y < r.top + edge ? -Math.min(12, (r.top + edge - cursor.y) / 4) : cursor.y > r.bottom - edge ? Math.min(12, (cursor.y - r.bottom + edge) / 4) : 0
            if (speed) { sc.scrollTop += speed; locate(cursor.x, cursor.y) }
          }
          frame = requestAnimationFrame(scroll)
        }
        handle.onclick = () => {
          if (suppressClick) { suppressClick = false; return }
          if (pos < 0 || !view.editable) return
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
          view.dom.dispatchEvent(new CustomEvent('layout-move-menu', { detail: handle.getBoundingClientRect() }))
        }
        handle.onpointerdown = (e) => {
          if (!view.editable || view.composing || e.button !== 0 || pos < 0 || !view.state.doc.nodeAt(pos)) return
          // Prevent text selection/native HTML dragging; a click still opens the destination menu.
          e.preventDefault()
          suppressClick = false
          pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, pos, started: false }
          try { handle.setPointerCapture(e.pointerId) } catch { /* window listeners still handle the interaction */ }
        }
        const move = (e: PointerEvent) => {
          if (!pointer || e.pointerId !== pointer.id) return
          if (!view.editable || view.composing) return cancel()
          if (!pointer.started) {
            if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 6) return
            const source = pointer.pos
            if (!view.state.doc.nodeAt(source)) return cancel()
            let range = blockRange(view.state)
            if (!range || source < range.from || source >= range.to) {
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, source)))
              range = blockRange(view.state)
            }
            if (!range || !pointer) return cancel()
            pointer.started = true
            suppressClick = true
            active = { view, range, doc: view.state.doc }
            view.dom.classList.add('layout-dragging')
            preview.textContent = range.nodes.length === 1 ? range.nodes[0].textContent.slice(0, 90) || t(range.nodes[0].type.name === GROUP ? 'Move layout' : 'Move block') : t('Moving {n} blocks', { n: range.nodes.length })
          }
          e.preventDefault()
          cursor = { x: e.clientX, y: e.clientY }
          preview.style.display = 'block'
          preview.style.left = `${Math.max(8, Math.min(e.clientX + 16, innerWidth - Math.min(preview.offsetWidth, 280) - 8))}px`
          preview.style.top = `${Math.max(8, Math.min(e.clientY + 16, innerHeight - preview.offsetHeight - 8))}px`
          locate(cursor.x, cursor.y)
          if (!frame) frame = requestAnimationFrame(scroll)
        }
        const up = (e: PointerEvent) => {
          if (!pointer || e.pointerId !== pointer.id) return
          if (!pointer.started) { release(); return }
          e.preventDefault()
          locate(e.clientX, e.clientY)
          const tr = active?.view === view && active.doc === view.state.doc && view.editable && target != null ? moveBlocks(view.state, active.range, target) : null
          // Cancel before dispatch so document changes cannot reuse transient positions.
          cancel()
          if (tr) { view.dispatch(tr); view.focus() }
        }
        const pointerCancel = (e: PointerEvent) => { if (pointer?.id === e.pointerId) cancel() }
        handle.onlostpointercapture = () => { if (pointer) cancel() }
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && pointer) { e.preventDefault(); cancel() } }
        host.addEventListener('mousemove', onMove)
        host.addEventListener('mouseleave', hideSoon)
        handle.onmouseenter = () => clearTimeout(timer)
        handle.onmouseleave = hideSoon
        window.addEventListener('pointermove', move, { passive: false })
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', pointerCancel)
        window.addEventListener('blur', cancel)
        window.addEventListener('keydown', key, true)
        view.dom.addEventListener(LAYOUT_CANCEL, cancel)
        return {
          update: (_view, prev) => { if (view.state.doc !== prev.doc || !view.editable) cancel() },
          destroy: () => {
            cancel()
            host.removeEventListener('mousemove', onMove)
            host.removeEventListener('mouseleave', hideSoon)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', pointerCancel)
            window.removeEventListener('blur', cancel)
            window.removeEventListener('keydown', key, true)
            view.dom.removeEventListener(LAYOUT_CANCEL, cancel)
            handle.remove(); marker.remove(); preview.remove()
          },
        }
      },
    })]
  },
})
