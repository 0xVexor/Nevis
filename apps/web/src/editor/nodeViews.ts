import type { Node as TiptapNode } from '@tiptap/core'
import { Drawing as DrawingBase, Image as ImageBase } from '@nevis/editor'
import { schemaExtensions, readColumnWidths } from '@nevis/schema'
import { t } from '../i18n'
import { openLightbox } from './lightbox'
import { createSectionDragSurface } from './snapSurface'

// Keep the new attachment loader and schema; only replace the controls and their layout.
export const Image = ImageBase.extend({
  addNodeView() {
    const render = this.parent?.()
    if (!render) throw new Error('Image node view is missing')
    return props => {
      const view = render(props)
      if (!(view.dom instanceof HTMLElement)) return view
      const fig = view.dom
      let current = props.node
      let cancelResize: (() => void) | null = null
      fig.classList.add('img-fig')
      const style = () => {
        fig.style.width = current.attrs.width > 0 ? `${current.attrs.width}%` : ''
        fig.classList.toggle('sized', current.attrs.width > 0)
        fig.querySelector<HTMLElement>('.image-frame')?.style.removeProperty('width')
        fig.querySelector('.image-bar')?.remove()
      }
      const handle = document.createElement('span')
      handle.className = 'img-handle'
      handle.contentEditable = 'false'
      handle.title = t('Drag to resize')
      handle.onpointerdown = event => {
        if (!props.editor.isEditable || event.button !== 0) return
        event.preventDefault(); event.stopPropagation()
        cancelResize?.()
        const original = props.editor.state.doc
        const startX = event.clientX, startWidth = fig.getBoundingClientRect().width
        const container = fig.closest<HTMLElement>('[data-type="layout-column"]') ?? props.editor.view.dom
        const width = container.clientWidth || 1
        const sign = getComputedStyle(fig).direction === 'rtl' ? -1 : 1
        let percent = Number(current.attrs.width) || 100
        const finish = (commit: boolean) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', cancel)
          window.removeEventListener('blur', cancel)
          cancelResize = null
          const pos = props.getPos()
          if (commit && !props.editor.isDestroyed && props.editor.isEditable && original === props.editor.state.doc && pos != null) {
            props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: percent }))
          } else style()
        }
        const move = (e: PointerEvent) => {
          if (e.pointerId !== event.pointerId) return
          percent = Math.min(100, Math.max(10, Math.round((startWidth + (e.clientX - startX) * sign) / width * 20) * 5))
          fig.style.width = `${percent}%`
        }
        const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish(true) }
        const cancel = () => finish(false)
        cancelResize = cancel
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancel)
        window.addEventListener('blur', cancel)
      }
      const enlarge = (event: MouseEvent) => {
        if (!(event.target instanceof HTMLImageElement)) return
        openLightbox({ src: event.target.src, alt: event.target.alt })
      }
      fig.addEventListener('dblclick', enlarge)
      fig.append(handle)
      style()
      return {
        ...view,
        update(node, ...args) {
          if (!view.update?.(node, ...args)) return false
          current = node
          cancelResize?.()
          style()
          return true
        },
        selectNode() { view.selectNode?.(); fig.classList.add('ProseMirror-selectednode') },
        deselectNode() { view.deselectNode?.(); fig.classList.remove('ProseMirror-selectednode') },
        stopEvent: event => event.target === handle || (view.stopEvent?.(event) ?? false),
        destroy() { cancelResize?.(); fig.removeEventListener('dblclick', enlarge); view.destroy?.() },
      }
    }
  },
})

const TableBase = schemaExtensions.find(extension => extension.name === 'table') as TiptapNode
export const Table = TableBase.extend({
  addNodeView() {
    return props => {
      let current = props.node
      const wrap = document.createElement('div')
      wrap.className = 'tableWrapper'
      const table = document.createElement('table')
      const cols = document.createElement('colgroup')
      const body = document.createElement('tbody')
      table.append(cols, body)
      wrap.append(createSectionDragSurface(t('Move table'), t('Drag this area to move the whole block.')), table)
      const apply = (node: typeof props.node) => {
        if (node.attrs.dir === 'auto') table?.removeAttribute('dir')
        else table?.setAttribute('dir', node.attrs.dir)
        wrap.style.width = node.attrs.tableWidth > 0 ? `${node.attrs.tableWidth}%` : ''
        wrap.dataset.align = node.attrs.tableAlign || ''
      }
      const columns = (node: typeof props.node) => {
        const widths: number[] = []
        node.firstChild?.forEach(cell => {
          const stored = readColumnWidths(cell.attrs.colwidthJson)
          for (let i = 0; i < cell.attrs.colspan; i++) widths.push(stored[i] || 0)
        })
        while (cols.children.length > widths.length) cols.lastChild?.remove()
        widths.forEach((width, i) => {
          const col = cols.children[i] as HTMLElement | undefined ?? cols.appendChild(document.createElement('col'))
          col.style.width = width ? `${width}px` : ''
        })
        const fixed = widths.length > 0 && widths.every(w => w > 0)
        wrap.toggleAttribute('data-fixed-cols', fixed)
        table.style.width = fixed ? `${widths.reduce((sum, w) => sum + w, 0)}px` : ''
      }
      apply(current); columns(current)
      return {
        dom: wrap, contentDOM: body,
        update(node) {
          if (node.type !== current.type) return false
          current = node
          apply(node); columns(node)
          return true
        },
        ignoreMutation: mutation => mutation.type !== 'selection' && !body.contains(mutation.target),
      }

    }
  },
})

export const Drawing = DrawingBase.extend({
  addNodeView() {
    const render = this.parent?.()
    if (!render) throw new Error('Drawing node view is missing')
    return props => {
      const view = render(props)
      if (!(view.dom instanceof HTMLElement)) return view
      const dom = view.dom
      const preview = dom.querySelector<HTMLElement>('.drawing-preview')
      preview?.classList.add('drawing-view')
      const edit = dom.querySelector<HTMLElement>('.drawing-edit')
      edit?.classList.remove('drawing-edit')
      edit?.classList.add('dr-edit')
      const bar = document.createElement('div')
      bar.className = 'drawing-actions'
      const big = document.createElement('button')
      big.type = 'button'; big.textContent = `⤢ ${t('Enlarge')}`
      big.onclick = () => { const svg = preview?.querySelector('svg'); if (svg) openLightbox({ svg: svg.outerHTML, alt: t('Drawing') }) }
      if (preview) preview.onclick = () => { if (props.editor.isEditable) edit?.click(); else big.click() }
      bar.append(big)
      if (edit) bar.append(edit)
      dom.prepend(createSectionDragSurface(t('Move drawing'), t('Drag this area to move the whole block.')), bar)
      const visibility = new MutationObserver(() => { big.hidden = !preview?.querySelector('svg') })
      if (preview) visibility.observe(preview, { childList: true })
      big.hidden = !preview?.querySelector('svg')
      return { ...view, stopEvent: event => (event.target instanceof Node && bar.contains(event.target)) || (view.stopEvent?.(event) ?? false), destroy() { visibility.disconnect(); view.destroy?.() } }
    }
  },
})
