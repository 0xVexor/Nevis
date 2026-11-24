// Adding attachments to the page: a file dropped on it, pasted into it, or picked from the slash menu. Each file is stored on this
// device first (`attachments.add`), and only then does a node that names it go into the page. A file that cannot be stored (too large,
// no room) leaves the page untouched and says why.
import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { explain, sniffBlob, type AttachmentRef } from './attachments'
import { insertBlock } from './insert'
import { optionsOf } from './options'

const imageNode = (r: AttachmentRef) => ({ type: 'image', attrs: { blob: r.blob, mime: r.mime, size: r.size, alt: r.name } })
const fileNode = (r: AttachmentRef) => ({ type: 'file', attrs: { blob: r.blob, mime: r.mime, size: r.size, name: r.name } })

/** Stores the files and inserts them, in order. Pictures become image blocks, everything else a file block. */
export async function attachFiles(editor: Editor, files: File[]): Promise<number> {
  const port = optionsOf(editor).attachments
  if (!port || !files.length) return 0
  let n = 0
  for (const f of files) {
    if (f.size > port.maxBytes) { explain(editor, { code: 'too_large' }); continue }
    try {
      const picture = await sniffBlob(f) // by content, not by the name or the type the browser reports
      const ref = await port.add(f, f.name, picture || f.type)
      if (editor.isDestroyed) return n
      insertBlock(editor, picture ? imageNode(ref) : fileNode(ref))
      n++
    } catch (e) { explain(editor, e) }
  }
  return n
}

/** The file picker (slash menu). `images`: only pictures are offered. */
export function pickAndAttach(editor: Editor, images: boolean): void {
  const input = document.createElement('input')
  input.type = 'file'; input.multiple = true
  if (images) input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
  input.style.display = 'none'
  input.dataset.testid = images ? 'attach-image-input' : 'attach-file-input'
  input.onchange = () => { const files = [...(input.files ?? [])]; input.remove(); void attachFiles(editor, files) }
  document.body.append(input)
  input.click()
}

export const AttachFiles = Extension.create({
  name: 'attachFiles',
  addProseMirrorPlugins() {
    const editor = this.editor
    const filesOf = (dt: DataTransfer | null) => [...(dt?.files ?? [])]
    return [new Plugin({
      props: {
        handleDrop: (_view, event) => {
          const files = filesOf((event as DragEvent).dataTransfer)
          if (!files.length || !optionsOf(editor).attachments) return false
          event.preventDefault()
          void attachFiles(editor, files)
          return true
        },
        handlePaste: (_view, event) => {
          const files = filesOf(event.clipboardData)
          if (!files.length || !optionsOf(editor).attachments) return false
          const html = event.clipboardData?.getData('text/html') ?? ''
          const text = event.clipboardData?.getData('text/plain') ?? ''
          if (html || text) {
            // Rich clipboard data often includes the same image as a file. Preserve the text and avoid a duplicate.
            const imageCount = (html.match(/<img\b/gi) ?? []).length || (text.match(/!\[[^\]]*\]\(/g) ?? []).length
            if (!imageCount || files.some(f => !f.type.startsWith('image/')) || files.length !== imageCount) queueMicrotask(() => void attachFiles(editor, files))
            return false
          }
          event.preventDefault()
          void attachFiles(editor, files)
          return true
        },
      },
    })]
  },
})
