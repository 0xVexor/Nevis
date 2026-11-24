// Image (a placeholder or an https URL until attachments exist in M9) and page link (an inline chip).
import type { NodeViewRendererProps } from '@tiptap/core'
import { nodeInputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Image as ImageSpec, PageLink as PageLinkSpec, isBlobHash, safeImageSrc } from '@nevis/schema'
import { explain, sniffBlob, whenAvailable } from '../attachments'
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

      // An attached image (`blob`): its bytes come from this device or the server, and are drawn from an object URL made HERE after the
      // bytes were looked at (only PNG, JPEG, GIF, WebP, AVIF are shown as pictures). Until they are there the block says so: a page can
      // arrive before its files, and nothing here ever writes to the page because bytes are missing.
      let blobState: 'loading' | 'ready' | 'notimage' = 'loading'
      let objectUrl: string | null = null
      let watching = ''
      let stop: (() => void) | null = null
      const release = () => { stop?.(); stop = null; watching = ''; if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null } blobState = 'loading' }
      const watch = (hash: string, mime: string) => {
        if (watching === hash) return
        release()
        watching = hash
        stop = whenAvailable(editor, hash, mime, b => {
          void sniffBlob(b).then(type => {
            if (watching !== hash) return
            if (objectUrl) URL.revokeObjectURL(objectUrl)
            objectUrl = type ? URL.createObjectURL(new Blob([b], { type })) : null
            blobState = type ? 'ready' : 'notimage'
            draw()
          })
        }, () => { if (blobState !== 'loading') { blobState = 'loading'; draw() } })
      }

      const draw = () => {
        frame.textContent = ''
        const a = cur.attrs
        dom.dataset.align = String(a.align)
        dom.style.width = Number(a.width) > 0 ? `${Number(a.width)}%` : ''
        if (isBlobHash(a.blob)) {
          watch(String(a.blob), String(a.mime))
          if (blobState === 'ready' && objectUrl) {
            const img = document.createElement('img')
            img.src = objectUrl; img.alt = String(a.alt); img.title = String(a.title); img.decoding = 'async'; img.draggable = false
            frame.append(img)
          } else {
            const ph = document.createElement('div')
            ph.className = 'image-placeholder'
            ph.dataset.state = blobState === 'notimage' ? 'notimage' : 'missing'
            ph.textContent = blobState === 'notimage' ? S.notAnImage : S.fileMissing
            frame.append(ph)
          }
          drawBar()
          return
        }
        release()
        const src = safeImageSrc(String(a.src)) // re-checked at render: a synced page is untrusted data
        if (src) {
          const img = document.createElement('img')
          img.src = src; img.alt = String(a.alt); img.title = String(a.title)
          img.onerror = () => {
            if (!img.isConnected) return
            const ph = document.createElement('div')
            ph.className = 'image-placeholder'
            ph.textContent = S.imageUnavailable
            img.replaceWith(ph)
            if (editor.isEditable) frame.append(placeholderEditor())
          }
          img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false
          frame.append(img)
        } else {
          const ph = document.createElement('div')
          ph.className = 'image-placeholder'
          ph.textContent = String(a.alt) || S.placeholderImage
          frame.append(ph)
          if (editor.isEditable) frame.append(placeholderEditor())
        }
        drawBar()
      }
      const drawBar = () => {
        const a = cur.attrs
        bar.textContent = ''
        if (!editor.isEditable) return
        for (const [label, w] of WIDTHS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = Number(a.width) === w ? 'on' : ''; b.onclick = () => set({ width: w }); bar.append(b) }
        for (const [label, v] of ALIGNS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = a.align === v ? 'on' : ''; b.onclick = () => set({ align: a.align === v ? '' : v }); bar.append(b) }
        if (!isBlobHash(a.blob) && optionsOf(editor).attachments) {
          const upload = document.createElement('button'); upload.type = 'button'; upload.textContent = S.imageAttach
          upload.onclick = () => {
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
            input.onchange = () => { const file = input.files?.[0]; const port = optionsOf(editor).attachments; if (!file || !port) return
              void (async () => { try {
                if (file.size > port.maxBytes) { explain(editor, { code: 'too_large' }); return }
                const mime = await sniffBlob(file); if (!mime) { explain(editor, new Error('Not an image')); return }
                const ref = await port.add(file, file.name, mime)
                if (!editor.isDestroyed) set({ blob: ref.blob, mime: ref.mime, size: ref.size, src: '' })
              } catch (error) { explain(editor, error) } })()
            }; input.click()
          }
          bar.append(upload)
        }
        const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = S.remove; rm.onclick = () => { const pos = getPos(); if (pos != null) editor.view.dispatch(editor.state.tr.delete(pos, pos + cur.nodeSize)) }
        bar.append(rm)
      }
      bar.onmousedown = e => e.preventDefault()
      draw()
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; draw(); return true },
        destroy: release,
        stopEvent: (e: Event) => bar.contains(e.target as Node) || (e.target as HTMLElement).closest?.('.image-url') !== null,
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
      }
    }
  },
})

export const PageLink = PageLinkSpec.extend({
  addInputRules() {
    return [nodeInputRule({ find: /\[\[([^\[\]\n]+)\]\]$/, type: this.type, getAttributes: match => ({ dstId: '', label: match[1]?.trim() }) })]
  },
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      let opening = false
      const dom = document.createElement('span')
      dom.className = 'page-link'
      dom.contentEditable = 'false'
      dom.setAttribute('dir', 'auto')
      dom.setAttribute('role', 'link')
      dom.tabIndex = 0
      const draw = () => {
        const pages = optionsOf(editor).pages?.()
        const found = pages?.find(p => p.id === cur.attrs.dstId)
        dom.textContent = found?.title || String(cur.attrs.label) || S.pageLinkMissing
        dom.classList.toggle('missing', !!pages && !found)
        dom.removeAttribute('title')
      }
      draw()
      const open = async (event: Event) => {
        event.preventDefault()
        if (opening) return
        const opts = optionsOf(editor)
        const { dstId, label } = cur.attrs
        const pages = opts.pages?.() ?? []
        if (pages.some(page => page.id === dstId) || !opts.pages) { opts.onOpenPage?.(String(dstId)); return }
        const title = String(label).trim()
        if (!title || !editor.isEditable || !opts.onCreateLinkedPage) return
        opening = true
        try {
          const lookup = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase()
          const sameTitle = pages.find(page => lookup(page.title) === lookup(title))
          const id = sameTitle?.id ?? await opts.onCreateLinkedPage(title)
          if (editor.isDestroyed || !editor.isEditable) return
          const pos = getPos()
          if (pos == null || cur.attrs.dstId !== dstId || cur.attrs.label !== label) return
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, dstId: id }))
          opts.onOpenPage?.(id)
        } catch (error) {
          console.error(error)
          opts.notify?.(S.pageLinkMissing)
        } finally { opening = false }
      }
      dom.addEventListener('click', event => void open(event))
      dom.addEventListener('keydown', event => { if (event.key === 'Enter') { event.stopPropagation(); void open(event) } })
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; draw(); return true },
        ignoreMutation: () => true,
      }
    }
  },
})
