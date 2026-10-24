import { Node, InputRule, mergeAttributes } from '@tiptap/core'
import katex from 'katex'
import { t } from '../i18n'

function paint(el: HTMLElement, latex: string, display: boolean) {
  if (!latex.trim()) {
    el.textContent = display ? t('Empty formula — click to write') : '∑'
    el.classList.add('math-empty')
    return
  }
  el.classList.remove('math-empty')
  try {
    katex.render(latex, el, { displayMode: display, throwOnError: false, output: 'html' })
  } catch {
    el.textContent = latex
  }
}

/** Click-to-edit for both math nodes: swaps the rendered output for a text field, commits on Enter/blur. */
function makeView(display: boolean) {
  return ({ node, editor, getPos }: any) => {
    let cur = node
    let editing = false
    const dom = document.createElement(display ? 'div' : 'span')
    dom.className = display ? 'math-block' : 'math-inline'
    dom.contentEditable = 'false'
    dom.setAttribute('dir', 'ltr')
    paint(dom, node.attrs.latex, display)

    const commit = (value: string | null) => {
      editing = false
      const pos = getPos()
      if (pos == null) return
      const { tr } = editor.state
      if (value === null) {
        paint(dom, cur.attrs.latex, display)
      } else if (!value.trim()) {
        tr.delete(pos, pos + cur.nodeSize)
        editor.view.dispatch(tr)
      } else {
        editor.view.dispatch(tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex: value }))
      }
      editor.view.focus()
    }

    const startEdit = () => {
      if (editing) return
      editing = true
      const field = document.createElement(display ? 'textarea' : 'input') as HTMLInputElement
      field.className = 'math-field'
      field.value = cur.attrs.latex
      field.placeholder = t('LaTeX, e.g. \\frac{a}{b}')
      field.setAttribute('dir', 'ltr')
      if (display) (field as any).rows = Math.max(2, cur.attrs.latex.split('\n').length)
      dom.replaceChildren(field)
      let done = false
      const finish = (v: string | null) => {
        if (done) return
        done = true
        commit(v)
      }
      field.onkeydown = (e) => {
        e.stopPropagation()
        if (e.key === 'Escape') finish(null)
        else if (e.key === 'Enter' && (!display || e.ctrlKey || e.metaKey)) (e.preventDefault(), finish(field.value))
      }
      field.onblur = () => finish(field.value)
      field.focus()
    }

    dom.onclick = () => editor.isEditable && startEdit() // reader mode: formulas are not editable
    if (!node.attrs.latex) setTimeout(startEdit, 0) // freshly inserted: go straight to typing

    return {
      dom,
      update: (n: any) => {
        if (n.type !== cur.type) return false
        cur = n
        if (!editing) paint(dom, n.attrs.latex, display)
        return true
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
    }
  }
}

const latexAttr = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? el.textContent ?? '',
    renderHTML: (a: any) => ({ 'data-latex': a.latex }),
  },
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => latexAttr,
  parseHTML: () => [{ tag: 'span[data-type="math-inline"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes({ 'data-type': 'math-inline' }, HTMLAttributes), node.attrs.latex],
  addNodeView: () => makeView(false),
  addInputRules() {
    const type = this.type
    // $x^2$ typed on a line becomes a formula when the closing $ is typed
    return [
      new InputRule({
        find: /(?:^|[^$\\\w])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/,
        handler: ({ state, range, match }) => {
          const from = range.from + match[0].indexOf('$')
          state.tr.replaceWith(from, range.to, type.create({ latex: match[1] }))
        },
      }),
    ]
  },
})

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => latexAttr,
  parseHTML: () => [{ tag: 'div[data-type="math-block"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'math-block' }, HTMLAttributes), node.attrs.latex],
  addNodeView: () => makeView(true),
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          const start = $from.before()
          state.tr.replaceWith(start, start + $from.parent.nodeSize, type.create({ latex: '' }))
        },
      }),
    ]
  },
})
