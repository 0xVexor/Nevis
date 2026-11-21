// Image (a placeholder or an https URL until attachments exist in M9) and page link (an inline chip).
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Image as ImageSpec, PageLink as PageLinkSpec, safeImageSrc } from '@nevis/schema'
import { optionsOf } from '../options'
import { S } from '../strings'

const WIDTHS: [string, number][] = [[S.size.s, 25], [S.size.m, 50], [S.size.l, 75], [S.size.full, 100]]
const ALIGNS: [string, string][] = [[S.align.start, 'start'], [S.align.center, 'center'], [S.align.end, 'end']]

export const Image = ImageSpec.extend({
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('figure')
      dom.className = 'image-block'
      dom.contentEditable = 'false'
      const frame = document.createElement('div')
      frame.className = 'image-frame'
      const bar = document.createElement('div')
      bar.className = 'image-bar'
      dom.append(frame, bar)
      const set = (patch: Record<string, unknown>) => { const pos = getPos(); if (pos != null && editor.isEditable) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...patch })) }

      const placeholderEditor = () => {
        const row = document.createElement('div')
        row.className = 'image-url'
        const input = document.createElement('input')
        input.type = 'url'; input.placeholder = S.imageFromWeb; input.setAttribute('dir', 'ltr')
        const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = S.save
        const apply = () => {
          const src = safeImageSrc(input.value)
          if (!src) { optionsOf(editor).notify?.(S.imageFromWeb); return }
          set({ src })
        }
        ok.onclick = apply
        input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); apply() } e.stopPropagation() }
        row.append(input, ok)
        return row
      }

      const draw = () => {
        frame.textContent = ''
        const a = cur.attrs
        const src = safeImageSrc(String(a.src)) // re-checked at render: a synced page is untrusted data
        dom.dataset.align = String(a.align)
        frame.style.width = Number(a.width) > 0 ? `${Number(a.width)}%` : ''
        if (src) {
          const img = document.createElement('img')
          img.src = src; img.alt = String(a.alt); img.title = String(a.title)
          img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false
          frame.append(img)
        } else {
          const ph = document.createElement('div')
          ph.className = 'image-placeholder'
          ph.textContent = String(a.alt) || S.placeholderImage
          frame.append(ph)
          if (editor.isEditable) frame.append(placeholderEditor())
        }
        bar.textContent = ''
        if (!editor.isEditable) return
        for (const [label, w] of WIDTHS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = Number(a.width) === w ? 'on' : ''; b.onclick = () => set({ width: w }); bar.append(b) }
        for (const [label, v] of ALIGNS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = a.align === v ? 'on' : ''; b.onclick = () => set({ align: a.align === v ? '' : v }); bar.append(b) }
        const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = S.remove; rm.onclick = () => { const pos = getPos(); if (pos != null) editor.view.dispatch(editor.state.tr.delete(pos, pos + cur.nodeSize)) }
        bar.append(rm)
      }
      bar.onmousedown = e => e.preventDefault()
      draw()
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; draw(); return true },
        stopEvent: (e: Event) => bar.contains(e.target as Node) || (e.target as HTMLElement).closest?.('.image-url') !== null,
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
      }
    }
  },
})

export const PageLink = PageLinkSpec.extend({
  addNodeView() {
    return ({ node, editor }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('span')
      dom.className = 'page-link'
      dom.contentEditable = 'false'
      dom.setAttribute('dir', 'auto')
      const draw = () => {
        const pages = optionsOf(editor).pages?.()
        const found = pages?.find(p => p.id === cur.attrs.dstId)
        dom.textContent = found?.title || String(cur.attrs.label) || S.pageLinkMissing
        dom.classList.toggle('missing', !!pages && !found)
        dom.title = String(cur.attrs.dstId)
      }
      draw()
      dom.addEventListener('click', e => { e.preventDefault(); optionsOf(editor).onOpenPage?.(String(cur.attrs.dstId)) })
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; draw(); return true },
        ignoreMutation: () => true,
      }
    }
  },
})
