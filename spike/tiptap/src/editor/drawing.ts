import { Node, mergeAttributes } from '@tiptap/core'
import { t as tr } from '../i18n'
import { urlFor } from '../attachments'
import { openLightbox } from './lightbox'

/**
 * A freehand drawing / whiteboard made with Excalidraw. The page only stores two file ids:
 * `scene` (the editable drawing, JSON) and `preview` (a picture of it, SVG). The page shows the picture;
 * the editor library is loaded only when someone clicks to edit.
 */
export const DrawingBlock = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      scene: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-scene') ?? '',
        renderHTML: (a) => ({ 'data-scene': a.scene }),
      },
      preview: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-preview') ?? '',
        renderHTML: (a) => ({ 'data-preview': a.preview }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="drawing"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'drawing' }, HTMLAttributes)],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = node
      let busy = false
      let shown = ''
      const dom = document.createElement('div')
      dom.className = 'drawing-block'
      dom.contentEditable = 'false'
      const view = document.createElement('div')
      view.className = 'drawing-view'
      const bar = document.createElement('div')
      bar.className = 'drawing-actions'
      const big = document.createElement('button')
      big.type = 'button'
      big.textContent = `⤢ ${tr('Enlarge')}`
      big.hidden = true
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'dr-edit'
      edit.textContent = tr('Edit drawing')
      bar.append(big, edit)
      dom.append(bar, view)

      let url: string | null = null
      const paint = async () => {
        const want = cur.attrs.preview as string
        if (want === shown) return
        shown = want
        big.hidden = !want
        if (!want) {
          view.className = 'drawing-view empty'
          view.textContent = tr('Empty drawing — click “Edit drawing”')
          url = null
          return
        }
        const u = await urlFor('att:' + want)
        if (want !== cur.attrs.preview) return // a newer version superseded this one
        url = u
        view.className = 'drawing-view'
        if (!u) return void (view.textContent = tr('The drawing file is missing'))
        const img = document.createElement('img')
        img.className = 'drawing-img'
        img.alt = tr('Drawing')
        img.draggable = false
        img.src = u
        view.replaceChildren(img)
      }
      void paint()

      const remove = () => {
        const pos = getPos()
        if (pos != null) editor.view.dispatch(editor.state.tr.delete(pos, pos + cur.nodeSize))
      }

      const open = async () => {
        if (!editor.isEditable || busy) return
        busy = true
        try {
          const { excalidraw, loadScene } = await import('./excalidraw')
          await excalidraw() // sets the asset path before the editor module is evaluated
          const [{ openDrawingEditor }, initial] = await Promise.all([import('../DrawingModal'), loadScene(cur.attrs.scene)])
          const r = await openDrawingEditor(initial)
          if (r && !r.scene) remove() // a drawing cleared down to nothing is not worth keeping as a block
          else if (r) {
            const pos = getPos()
            if (pos != null) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...r }))
          } else if (!cur.attrs.scene) remove() // cancelled straight after inserting
        } finally {
          busy = false
          editor.view.focus()
        }
      }

      const enlarge = () => url && openLightbox({ src: url, alt: tr('Drawing') })
      big.onclick = enlarge
      edit.onclick = () => void open()
      // reader mode: the picture can be looked at and enlarged, not edited
      view.onclick = () => (editor.isEditable ? void open() : enlarge())
      if (!node.attrs.scene && editor.isEditable) setTimeout(() => void open(), 0) // freshly inserted: straight to drawing

      return {
        dom,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          void paint()
          return true
        },
        stopEvent: () => bar.matches(':hover'),
        ignoreMutation: () => true,
      }
    }
  },
})
