import { Node, Extension, InputRule, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
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

// ───────── text → formula when you leave it ─────────
const autoKey = new PluginKey('mathAuto')
const INLINE = /(?<![\\$\w])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\w$])/g

/** Turns `$…$` inside a paragraph into inline formulas, and a paragraph that is just `$$…$$` into a formula block. */
function convertBlock(tr: any, pos: number, schema: any) {
  const node = tr.doc.nodeAt(pos)
  if (!node || !node.isTextblock || !['paragraph', 'heading'].includes(node.type.name)) return
  const whole = node.textContent.trim().match(/^\$\$([\s\S]+)\$\$$/)
  if (whole && node.childCount === 1 && node.firstChild!.isText && schema.nodes.mathBlock) {
    tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.mathBlock.create({ latex: whole[1].trim() }))
    return
  }
  const inline = schema.nodes.mathInline
  if (!inline) return
  const edits: { from: number; to: number; latex: string }[] = []
  node.forEach((child: any, offset: number) => {
    if (!child.isText || child.marks.some((m: any) => m.type.name === 'code')) return
    for (const m of child.text.matchAll(INLINE)) {
      const from = pos + 1 + offset + m.index
      edits.push({ from, to: from + m[0].length, latex: m[1] })
    }
  })
  for (const e of edits.reverse()) tr.replaceWith(e.from, e.to, inline.create({ latex: e.latex }))
}

/** A formula typed as plain `$x^2$` stays text while you are on that line; it becomes a real formula as soon as the cursor leaves the paragraph, the editor loses focus, or you run "convert formulas". */
export const MathAuto = Extension.create({
  name: 'mathAuto',
  addCommands() {
    return { convertFormulas: () => ({ tr, dispatch }: any) => (dispatch?.(tr.setMeta(autoKey, 'all')), true) } as any
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: autoKey,
        props: { handleDOMEvents: { blur: (view: any) => (view.dispatch(view.state.tr.setMeta(autoKey, 'all')), false) } },
        appendTransaction(trs: readonly any[], oldState: any, newState: any) {
          if (trs.some((t) => t.getMeta(autoKey) === 'skip')) return null
          const all = trs.some((t) => t.getMeta(autoKey) === 'all')
          if (!all && !trs.some((t) => t.selectionSet || t.docChanged)) return null
          const targets = new Set<number>()
          if (all) {
            newState.doc.descendants((n: any, p: number) => {
              if (n.isTextblock) targets.add(p)
              return !n.isTextblock
            })
          } else {
            // only the paragraph the cursor just left
            const $o = oldState.selection.$from
            if ($o.depth < 1) return null
            let p = $o.before($o.depth)
            for (const t of trs) p = t.mapping.map(p)
            const $n = newState.selection.$from
            const same = $n.depth >= 1 && $n.before($n.depth) === p
            if (same) return null
            targets.add(p)
          }
          const tr = newState.tr
          let changed = false
          for (const p of [...targets].sort((a, b) => b - a)) {
            const before = tr.docChanged
            convertBlock(tr, tr.mapping.map(p), newState.schema)
            changed = changed || tr.docChanged !== before || tr.docChanged
          }
          if (!tr.docChanged) return null
          tr.setMeta(autoKey, 'skip')
          return changed ? tr : null
        },
      }),
    ]
  },
})
