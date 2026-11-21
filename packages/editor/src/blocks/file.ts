// The file block (SV 3, M9): a card with the file's name and size. Clicking it saves the file: the bytes come from this device or the
// server and are handed to the browser as an opaque download (octet-stream, `download` attribute), never opened as a page.
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { FileBlock as FileSpec, isBlobHash } from '@nevis/schema'
import { formatSize, whenAvailable } from '../attachments'
import { optionsOf } from '../options'
import { S } from '../strings'

export const FileBlock = FileSpec.extend({
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      let here = false // the bytes are available now
      let stop: (() => void) | null = null
      let watching = ''
      const dom = document.createElement('div')
      dom.className = 'file-block'
      dom.contentEditable = 'false'
      const card = document.createElement('button')
      card.type = 'button'; card.className = 'file-card'; card.dataset.testid = 'file-card'
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = '📎'
      const text = document.createElement('span'); text.className = 'file-text'
      const nameEl = document.createElement('span'); nameEl.className = 'file-name'
      const meta = document.createElement('span'); meta.className = 'file-meta'
      text.append(nameEl, meta)
      card.append(icon, text)
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'file-remove'; rm.textContent = S.remove
      rm.onclick = () => { const pos = getPos(); if (pos != null && editor.isEditable) editor.view.dispatch(editor.state.tr.delete(pos, pos + cur.nodeSize)) }
      dom.append(card, rm)
      const draw = () => {
        const a = cur.attrs
        nameEl.textContent = String(a.name) || S.file
        meta.textContent = here ? `${formatSize(Number(a.size))} · ${S.download}` : `${formatSize(Number(a.size))} · ${S.fileMissing}`
        dom.dataset.state = here ? 'ready' : 'missing'
        rm.hidden = !editor.isEditable
        const hash = String(a.blob)
        if (watching !== hash) {
          stop?.(); here = false; watching = hash
          stop = isBlobHash(hash) ? whenAvailable(editor, hash, String(a.mime), () => { here = true; draw() }, () => { if (here) { here = false; draw() } }) : null
        }
      }
      card.onclick = async () => {
        const hash = String(cur.attrs.blob)
        const port = optionsOf(editor).attachments
        const b = isBlobHash(hash) && port ? await port.open(hash, String(cur.attrs.mime)).catch(() => null) : null
        if (!b) { optionsOf(editor).notify?.(S.fileMissing); return }
        const url = URL.createObjectURL(new Blob([b], { type: 'application/octet-stream' }))
        const a = document.createElement('a')
        a.href = url; a.download = String(cur.attrs.name) || 'file'; a.rel = 'noopener'
        document.body.append(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
      }
      draw()
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; draw(); return true },
        destroy: () => { stop?.() },
        stopEvent: (e: Event) => (e.target as HTMLElement).closest('button') !== null,
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
      }
    }
  },
})
