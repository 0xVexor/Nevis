import { Node, mergeAttributes } from '@tiptap/core'
import { t } from '../i18n'

const CALLOUT_EMOJIS = ['💡', '⚠️', '❗', '✅', 'ℹ️', '🔥', '📌']

/** Highlighted box with a clickable emoji (cycles through CALLOUT_EMOJIS). Holds any blocks. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: (el) => el.getAttribute('data-emoji') || '💡',
        renderHTML: (a) => ({ 'data-emoji': a.emoji }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'callout' }, HTMLAttributes), 0],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'callout'
      dom.setAttribute('dir', 'auto') // marker follows the language of the content
      const btn = document.createElement('button')
      btn.className = 'callout-ic'
      btn.type = 'button'
      btn.contentEditable = 'false'
      btn.title = t('Change icon')
      btn.textContent = node.attrs.emoji
      btn.onmousedown = (e) => e.preventDefault()
      btn.onclick = () => {
        const pos = getPos()
        if (pos == null || !editor.isEditable) return
        const next = CALLOUT_EMOJIS[(CALLOUT_EMOJIS.indexOf(cur.attrs.emoji) + 1) % CALLOUT_EMOJIS.length]
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, emoji: next }))
      }
      const body = document.createElement('div')
      body.className = 'callout-body'
      dom.append(btn, body)
      return {
        dom,
        contentDOM: body,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          btn.textContent = n.attrs.emoji
          return true
        },
        stopEvent: (e) => e.target === btn,
        ignoreMutation: (m) => btn.contains(m.target),
      }
    }
  },
})

/** Collapsible block: the first paragraph is the always-visible title, the rest is hidden when closed. */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.getAttribute('data-open') !== 'false',
        renderHTML: (a) => ({ 'data-open': String(a.open) }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="toggle"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'toggle' }, HTMLAttributes), 0],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'toggle' + (node.attrs.open ? ' open' : '')
      dom.setAttribute('dir', 'auto')
      const btn = document.createElement('button')
      btn.className = 'toggle-btn'
      btn.type = 'button'
      btn.contentEditable = 'false'
      btn.title = t('Expand / collapse')
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      btn.onmousedown = (e) => e.preventDefault()
      btn.onclick = () => {
        const pos = getPos()
        if (!editor.isEditable) return void dom.classList.toggle('open') // reading: opening a toggle is only a view state, the page is not changed
        if (pos == null) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, open: !cur.attrs.open }))
      }
      const body = document.createElement('div')
      body.className = 'toggle-body'
      dom.append(btn, body)
      return {
        dom,
        contentDOM: body,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          dom.classList.toggle('open', !!n.attrs.open)
          return true
        },
        stopEvent: (e) => btn.contains(e.target as any), // `Node` here is TipTap's, hence the cast
        ignoreMutation: (m) => btn.contains(m.target) || (m.type === 'attributes' && m.target === dom),
      }
    }
  },
})
