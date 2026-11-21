// Node views of the container blocks: callout (icon button), toggle (arrow), layout columns. Behaviour only: the schema is in @nevis/schema.
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Callout as CalloutSpec, LayoutColumn as ColumnSpec, LayoutGroup as GroupSpec, Toggle as ToggleSpec } from '@nevis/schema'
import { CALLOUT_ICONS, iconSvg } from '../icons'
import { S } from '../strings'

const button = (cls: string, title: string, html: string) => {
  const b = document.createElement('button')
  b.className = cls; b.type = 'button'; b.contentEditable = 'false'; b.title = title; b.innerHTML = html
  b.onmousedown = e => e.preventDefault()
  return b
}

export const Callout = CalloutSpec.extend({
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'callout'
      dom.setAttribute('dir', 'auto') // the marker follows the language of the content
      const btn = button('callout-ic', S.changeIcon, iconSvg(String(node.attrs.icon)))
      btn.onclick = () => {
        const pos = getPos()
        if (pos == null || !editor.isEditable) return
        const next = CALLOUT_ICONS[(Math.max(0, CALLOUT_ICONS.indexOf(String(cur.attrs.icon))) + 1) % CALLOUT_ICONS.length]!
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, icon: next }))
      }
      const body = document.createElement('div')
      body.className = 'callout-body'
      dom.append(btn, body)
      return {
        dom, contentDOM: body,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; btn.innerHTML = iconSvg(String(n.attrs.icon)); return true },
        stopEvent: e => e.target === btn,
        ignoreMutation: m => btn.contains(m.target),
      }
    }
  },
})

export const Toggle = ToggleSpec.extend({
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'toggle' + (node.attrs.open ? ' open' : '')
      dom.setAttribute('dir', 'auto')
      const btn = button('toggle-btn', S.toggle, '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>')
      btn.onclick = () => {
        const pos = getPos()
        if (!editor.isEditable) return void dom.classList.toggle('open') // reading: opening a toggle is a view state, the page is not changed
        if (pos == null) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, open: !cur.attrs.open }))
      }
      const body = document.createElement('div')
      body.className = 'toggle-body'
      dom.append(btn, body)
      return {
        dom, contentDOM: body,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; dom.classList.toggle('open', !!n.attrs.open); return true },
        stopEvent: e => btn.contains(e.target as HTMLElement),
        ignoreMutation: m => btn.contains(m.target) || (m.type === 'attributes' && m.target === dom),
      }
    }
  },
})

/** Column widths are relative integers (0 = an equal share): the group is a CSS grid whose tracks are read from its columns. */
const tracks = (group: PMNode): string => {
  const w: number[] = []
  group.forEach(c => w.push(Number(c.attrs.width) > 0 ? Number(c.attrs.width) : 0))
  const fallback = w.some(x => x > 0) ? Math.round(w.filter(x => x > 0).reduce((a, b) => a + b, 0) / w.filter(x => x > 0).length) : 1
  return w.map(x => `minmax(0, ${x || fallback}fr)`).join(' ')
}

export const LayoutGroup = GroupSpec.extend({
  addNodeView() {
    return ({ node }: NodeViewRendererProps) => {
      const dom = document.createElement('div')
      dom.className = 'layout-group'
      dom.dataset.type = 'layout-group'
      dom.style.setProperty('--layout-tracks', tracks(node))
      const dir = String(node.attrs.dir)
      if (dir !== 'auto') dom.setAttribute('dir', dir)
      return {
        dom, contentDOM: dom,
        update: (n: PMNode) => {
          if (n.type !== node.type) return false
          dom.style.setProperty('--layout-tracks', tracks(n))
          if (n.attrs.dir !== 'auto') dom.setAttribute('dir', String(n.attrs.dir)); else dom.removeAttribute('dir')
          return true
        },
        ignoreMutation: m => m.type === 'attributes' && m.target === dom,
      }
    }
  },
})

export const LayoutColumn = ColumnSpec.extend({
  addNodeView() {
    return ({ node, getPos, view }: NodeViewRendererProps) => {
      const dom = document.createElement('div')
      dom.className = 'layout-column'
      dom.dataset.type = 'layout-column'
      dom.setAttribute('role', 'group')
      const label = () => { const pos = getPos(); if (pos != null) dom.setAttribute('aria-label', S.column(view.state.doc.resolve(pos).index() + 1)) }
      label()
      return {
        dom, contentDOM: dom,
        update: (next: PMNode) => { if (next.type !== node.type) return false; label(); return true },
        ignoreMutation: m => m.type === 'attributes' && m.target === dom,
      }
    }
  },
})
