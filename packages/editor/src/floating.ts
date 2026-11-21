// The formatting bar over a text selection and the table bar inside a table (ported in spirit from the old menu.ts / table menu; vanilla
// DOM, positioned from the selection's coordinates). Never shown while composing (IME) or when the editor is read-only.
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { isSafeHref } from '@nevis/schema'
import { optionsOf } from './options'

interface Btn { label: string; title: string; run: (e: Editor) => void; active?: (e: Editor) => boolean }

const TEXT: Btn[] = [
  { label: 'B', title: 'پررنگ', run: e => e.chain().focus().toggleBold().run(), active: e => e.isActive('bold') },
  { label: 'I', title: 'کج', run: e => e.chain().focus().toggleItalic().run(), active: e => e.isActive('italic') },
  { label: 'U', title: 'زیرخط', run: e => e.chain().focus().toggleUnderline().run(), active: e => e.isActive('underline') },
  { label: 'S', title: 'خط‌خورده', run: e => e.chain().focus().toggleStrike().run(), active: e => e.isActive('strike') },
  { label: '</>', title: 'کد', run: e => e.chain().focus().toggleCode().run(), active: e => e.isActive('code') },
  { label: '←', title: 'راست‌به‌چپ', run: e => e.chain().focus().setDirection('rtl').run() },
  { label: '→', title: 'چپ‌به‌راست', run: e => e.chain().focus().setDirection('ltr').run() },
  { label: '≡', title: 'تراز: وسط', run: e => e.chain().focus().setTextAlign('center').run() },
]
const TABLE: Btn[] = [
  { label: '+ردیف', title: 'ردیف بعد', run: e => e.chain().focus().addRowAfter().run() },
  { label: '-ردیف', title: 'حذف ردیف', run: e => e.chain().focus().deleteRow().run() },
  { label: '+ستون', title: 'ستون بعد', run: e => e.chain().focus().addColumnAfter().run() },
  { label: '-ستون', title: 'حذف ستون', run: e => e.chain().focus().deleteColumn().run() },
  { label: 'عنوان', title: 'ردیف عنوان', run: e => e.chain().focus().toggleHeaderRow().run() },
  { label: '←', title: 'جدول راست‌به‌چپ', run: e => e.chain().focus().setTableDirection('rtl').run() },
  { label: '→', title: 'جدول چپ‌به‌راست', run: e => e.chain().focus().setTableDirection('ltr').run() },
  { label: '۷۵٪', title: 'عرض جدول', run: e => e.chain().focus().setTableWidth(75).run() },
  { label: '۱۰۰٪', title: 'تمام‌عرض', run: e => e.chain().focus().setTableWidth(100).run() },
  { label: 'حذف', title: 'حذف جدول', run: e => e.chain().focus().deleteTable().run() },
]

const key = new PluginKey('floatingBars')

export const FloatingBars = Extension.create({
  name: 'floatingBars',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      key,
      view: (view: EditorView) => {
        const bar = document.createElement('div')
        bar.className = 'floating-bar'
        bar.setAttribute('dir', 'rtl')
        bar.style.display = 'none'
        bar.onmousedown = e => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault() }
        document.body.append(bar)
        let linking = false
        const draw = (btns: Btn[], withLink: boolean) => {
          bar.textContent = ''
          for (const b of btns) {
            const el = document.createElement('button')
            el.type = 'button'; el.textContent = b.label; el.title = b.title; el.className = b.active?.(editor) ? 'on' : ''
            el.onclick = () => b.run(editor)
            bar.append(el)
          }
          if (withLink) {
            const el = document.createElement('button'); el.type = 'button'; el.textContent = 'پیوند'; el.title = 'پیوند'; el.className = editor.isActive('link') ? 'on' : ''
            el.onclick = () => { if (editor.isActive('link')) editor.chain().focus().unsetLink().run(); else { linking = true; update() } }
            bar.append(el)
          }
        }
        const linkRow = () => {
          bar.textContent = ''
          const input = document.createElement('input')
          input.type = 'url'; input.placeholder = 'https://…'; input.setAttribute('dir', 'ltr')
          const apply = () => {
            const href = input.value.trim()
            if (!isSafeHref(href)) { optionsOf(editor).notify?.('پیوند باید با https، http، mailto یا tel شروع شود'); return }
            linking = false
            editor.chain().focus().setLink({ href }).run()
          }
          input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); apply() } else if (e.key === 'Escape') { linking = false; update(); editor.commands.focus() } e.stopPropagation() }
          const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = 'تأیید'; ok.onclick = apply
          bar.append(input, ok)
          queueMicrotask(() => input.focus())
        }
        const place = (from: number, to: number) => {
          bar.style.display = 'flex'
          const a = view.coordsAtPos(from), b = view.coordsAtPos(to)
          const top = Math.min(a.top, b.top) - bar.offsetHeight - 6
          bar.style.top = `${top < 8 ? Math.max(a.bottom, b.bottom) + 6 : top}px`
          bar.style.left = `${Math.max(8, Math.min((a.left + b.left) / 2 - bar.offsetWidth / 2, window.innerWidth - bar.offsetWidth - 8))}px`
        }
        const update = () => {
          const { state } = view
          const { from, to, empty } = state.selection
          const inTable = state.selection.$from.node(-1)?.type.name === 'tableCell' || (() => { for (let d = state.selection.$from.depth; d > 0; d--) { const n = state.selection.$from.node(d).type.name; if (n === 'table') return true } return false })()
          const textSel = !empty && state.doc.textBetween(from, to, ' ').trim().length > 0 && !('node' in state.selection)
          if (!editor.isEditable || view.composing || !view.hasFocus() && !linking) { bar.style.display = 'none'; return }
          if (linking) { linkRow(); place(from, to); return }
          if (textSel) { draw(TEXT, true); place(from, to) }
          else if (inTable) { draw(TABLE, false); place(from, to) }
          else bar.style.display = 'none'
        }
        return { update, destroy: () => bar.remove() }
      },
    })]
  },
})
