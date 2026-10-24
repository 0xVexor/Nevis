import { Node, InputRule, mergeAttributes } from '@tiptap/core'
import { t as tr } from '../i18n'
import { cleanMermaid } from "./mermaidText"
import { openLightbox } from "./lightbox"
export { looksLikeMermaid, cleanMermaid } from "./mermaidText"

const MERMAID_SAMPLE = 'flowchart TD\n  A[شروع] --> B{شرط؟}\n  B -- بله --> C[انجام بده]\n  B -- نه --> D[پایان]\n  C --> D'

type Mermaid = typeof import('mermaid').default
let lib: Promise<Mermaid> | null = null
let theme = ''
let seq = 0

/** Loaded on first use only (the library is large); re-initialised when the light/dark theme changes. */
async function mermaid(): Promise<Mermaid> {
  lib ??= import('mermaid').then((m) => m.default)
  const m = await lib
  const dark = getComputedStyle(document.body).colorScheme.includes('dark') || document.documentElement.dataset.theme === 'dark'
  const want = dark ? 'dark' : 'default'
  if (theme !== want) {
    m.initialize({ startOnLoad: false, theme: want, securityLevel: 'strict', fontFamily: 'inherit' })
    theme = want
  }
  return m
}

export async function renderDiagram(code: string): Promise<{ svg: string } | { error: string }> {
  try {
    const m = await mermaid()
    return { svg: (await m.render(`mmd-${++seq}`, cleanMermaid(code))).svg }
  } catch (e) {
    document.getElementById(`dmmd-${seq}`)?.remove() // mermaid leaves its scratch element behind on a syntax error
    return { error: String((e as Error)?.message ?? e).split('\n')[0] }
  }
}

const views = new Set<() => void>()
// diagrams carry the theme in their SVG, so they are redrawn when the theme changes
new MutationObserver(() => views.forEach((v) => v())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })

/** A diagram written in Mermaid text. Click to edit the source; the picture updates as you type. */
export const MermaidBlock = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  selectable: true,
  priority: 200, // so that typing ```mermaid + space beats the plain code-block rule
  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-code') ?? el.textContent ?? '',
        renderHTML: (a) => ({ 'data-code': a.code }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="mermaid"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'mermaid' }, HTMLAttributes), node.attrs.code],
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /^```mermaid\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          const start = $from.before()
          state.tr.replaceWith(start, start + $from.parent.nodeSize, type.create({ code: '' }))
        },
      }),
    ]
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = node
      let editing = false
      let token = 0
      const dom = document.createElement('div')
      dom.className = 'mermaid-block'
      dom.contentEditable = 'false'
      dom.setAttribute('dir', 'ltr')
      const view = document.createElement('div')
      view.className = 'mermaid-view'
      const bar = document.createElement('div')
      bar.className = 'mermaid-bar'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.textContent = tr('Edit code')

      // enlarge: opens the zoom/pan viewer with the current picture
      const big = document.createElement('button')
      big.type = 'button'
      big.textContent = `⤢ ${tr('Enlarge')}`
      big.hidden = true
      big.className = 'mm-big'
      big.onclick = () => {
        const svg = view.querySelector('svg')
        if (svg) openLightbox({ svg: svg.outerHTML, alt: tr('Diagram') })
      }

      // convert to code: the same text as an ordinary code block (it can be turned back with "Show as diagram")
      const toCode = document.createElement('button')
      toCode.type = 'button'
      toCode.textContent = `</> ${tr('Convert to code')}`
      toCode.onclick = () => {
        const pos = getPos()
        const cb = editor.schema.nodes.codeBlock
        if (pos == null || !cb || !editor.isEditable) return
        const text = cur.attrs.code as string
        editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + cur.nodeSize, cb.create({ language: 'mermaid' }, text ? editor.schema.text(text) : undefined)))
        editor.view.focus()
      }
      bar.append(big, toCode, edit)
      dom.append(bar, view)

      const paint = async (code: string, into: HTMLElement = view) => {
        const mine = ++token
        if (!code.trim()) {
          into.textContent = tr('Empty diagram — click “Edit code”')
          into.className = into === view ? 'mermaid-view empty' : into.className
          return
        }
        const r = await renderDiagram(code)
        if (mine !== token) return // a newer render superseded this one
        if (into === view) big.hidden = !('svg' in r) // nothing to enlarge when the code has an error
        into.classList.remove('empty')
        if ('svg' in r) {
          into.classList.remove('error')
          into.innerHTML = r.svg
        } else {
          into.classList.add('error')
          into.textContent = r.error
        }
      }
      const redraw = () => !editing && void paint(cur.attrs.code)
      views.add(redraw)
      paint(node.attrs.code)

      const commit = (value: string | null) => {
        editing = false
        dom.classList.remove('editing')
        panel.remove()
        const pos = getPos()
        if (pos != null && value !== null && value !== cur.attrs.code) {
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, code: value }))
        } else paint(cur.attrs.code)
        editor.view.focus()
      }

      const panel = document.createElement('div')
      panel.className = 'mermaid-edit'
      const startEdit = () => {
        if (editing) return
        editing = true
        dom.classList.add('editing')
        const ta = document.createElement('textarea')
        ta.className = 'mermaid-src'
        ta.value = cur.attrs.code || MERMAID_SAMPLE
        ta.spellcheck = false
        ta.setAttribute('dir', 'ltr')
        ta.rows = Math.max(5, ta.value.split('\n').length + 1)
        const hint = document.createElement('div')
        hint.className = 'mermaid-hint'
        hint.textContent = tr('Ctrl+Enter save · Esc cancel · the diagram updates as you type')
        panel.replaceChildren(ta, hint)
        dom.append(panel)
        let t = 0
        ta.oninput = () => {
          ta.rows = Math.max(5, ta.value.split('\n').length + 1)
          window.clearTimeout(t)
          t = window.setTimeout(() => paint(ta.value), 350)
        }
        ta.onkeydown = (e) => {
          e.stopPropagation()
          if (e.key === 'Escape') (e.preventDefault(), (done = true), commit(null))
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), (done = true), commit(ta.value))
          else if (e.key === 'Tab') {
            e.preventDefault()
            ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end')
            ta.dispatchEvent(new Event('input'))
          }
        }
        let done = false
        ta.onblur = () => !done && ((done = true), commit(ta.value))
        paint(ta.value)
        ta.focus()
      }
      // reader mode (editor not editable): the diagram can be looked at and enlarged, not edited
      edit.onclick = () => editor.isEditable && startEdit()
      view.onclick = () => editor.isEditable && startEdit()
      if (!node.attrs.code) setTimeout(startEdit, 0) // freshly inserted: straight to writing

      return {
        dom,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          if (!editing) paint(n.attrs.code)
          return true
        },
        stopEvent: () => editing || bar.matches(':hover'),
        ignoreMutation: () => true,
        destroy: () => void views.delete(redraw),
      }
    }
  },
})
