import { Node, Extension, InputRule, mergeAttributes } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state'
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

/** Live preview while editing: the real formula, or the parse error in plain words. */
function live(box: HTMLElement, latex: string, display: boolean) {
  box.classList.remove('math-err', 'math-empty')
  if (!latex.trim()) {
    box.classList.add('math-empty')
    box.textContent = t('Type LaTeX above, e.g. \\frac{a}{b}')
    return
  }
  try {
    katex.render(latex, box, { displayMode: display, throwOnError: true, output: 'html' })
  } catch (e: any) {
    box.classList.add('math-err')
    box.textContent = String(e?.message ?? e).replace(/^KaTeX parse error:\s*/, '')
  }
}

/** Click (or Enter on a selected formula) opens an editor with a live preview; Enter saves and moves on, Esc cancels. */
function makeView(display: boolean) {
  return ({ node, editor, getPos }: any) => {
    let cur = node
    let editing = false
    const dom = document.createElement(display ? 'div' : 'span')
    dom.className = display ? 'math-block' : 'math-inline'
    dom.contentEditable = 'false'
    dom.setAttribute('dir', 'ltr')
    paint(dom, node.attrs.latex, display)

    /** After saving, the caret goes right after the formula (a new line under a block one) so writing continues. */
    const caretAfter = (pos: number, size: number) => {
      let after = pos + size
      if (display && after >= editor.state.doc.content.size) {
        editor.view.dispatch(editor.state.tr.insert(after, editor.schema.nodes.paragraph.create()))
      }
      const doc = editor.state.doc
      after = Math.min(after, doc.content.size)
      editor.view.dispatch(editor.state.tr.setSelection(Selection.near(doc.resolve(after), 1)))
      editor.view.focus()
    }

    const commit = (value: string | null) => {
      editing = false
      const pos = getPos()
      if (pos == null) return
      const size = cur.nodeSize
      if (value === null) {
        // cancelling a formula that was never filled in removes it instead of leaving an empty placeholder
        if (!cur.attrs.latex.trim()) editor.view.dispatch(editor.state.tr.delete(pos, pos + size))
        else paint(dom, cur.attrs.latex, display)
        editor.view.focus()
      } else if (!value.trim()) {
        editor.view.dispatch(editor.state.tr.delete(pos, pos + size))
        editor.view.focus()
      } else {
        if (value !== cur.attrs.latex) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex: value }))
        else paint(dom, cur.attrs.latex, display)
        caretAfter(pos, size)
      }
    }

    const startEdit = () => {
      if (editing || !editor.isEditable) return
      editing = true
      const wrap = document.createElement('span')
      wrap.className = 'math-edit' + (display ? ' block' : '')
      const field = document.createElement(display ? 'textarea' : 'input') as HTMLInputElement
      field.className = 'math-field'
      field.value = cur.attrs.latex
      field.placeholder = t('LaTeX, e.g. \\frac{a}{b}')
      field.spellcheck = false
      field.setAttribute('dir', 'ltr')
      const pop = document.createElement('div')
      pop.className = 'math-pop'
      const preview = document.createElement('div')
      preview.className = 'math-live'
      const hint = document.createElement('div')
      hint.className = 'math-hint'
      hint.textContent = display ? t('Enter: save · Shift+Enter: new line · Esc: cancel') : t('Enter: save · Esc: cancel')
      pop.append(preview, hint)
      wrap.append(field, pop)
      dom.replaceChildren(wrap)
      const size = () => {
        if (display) {
          field.style.height = 'auto'
          field.style.height = field.scrollHeight + 2 + 'px'
        } else field.style.width = Math.max(10, field.value.length + 2) + 'ch'
      }
      field.oninput = () => (live(preview, field.value, display), size())
      live(preview, field.value, display)
      size()
      let done = false
      const finish = (v: string | null) => {
        if (done) return
        done = true
        commit(v)
      }
      field.onkeydown = (e) => {
        e.stopPropagation()
        if (e.key === 'Escape') (e.preventDefault(), finish(null))
        else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) (e.preventDefault(), finish(field.value))
        else if (e.key === 'Enter' && !display) e.preventDefault() // Shift+Enter: a new line only exists in block formulas
      }
      field.onblur = () => finish(field.value)
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    }

    ;(dom as any).__edit = startEdit
    dom.onclick = () => startEdit() // reader mode: not editable (startEdit checks)
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
  addKeyboardShortcuts() {
    return {
      // Enter on a selected formula edits it
      Enter: ({ editor }: any) => {
        const sel = editor.state.selection
        if (!(sel instanceof NodeSelection) || !['mathInline', 'mathBlock'].includes(sel.node.type.name)) return false
        const dom = editor.view.nodeDOM(sel.from) as any
        dom?.__edit?.()
        return !!dom?.__edit
      },
      // Ctrl+Shift+M: on an empty line a block formula, on selected text a formula made of it, otherwise an empty inline formula
      'Mod-Shift-m': ({ editor }: any) => {
        const { selection: sel, doc } = editor.state
        const $from = sel.$from
        if (sel.empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
          return editor.chain().focus().insertContentAt({ from: $from.before(), to: $from.after() }, { type: 'mathBlock', attrs: { latex: '' } }).run()
        }
        if (!sel.empty) {
          const text = doc.textBetween(sel.from, sel.to, ' ').trim()
          if (text) return editor.chain().focus().insertContentAt({ from: sel.from, to: sel.to }, { type: 'mathInline', attrs: { latex: text } }).run()
        }
        return editor.chain().focus().insertContent({ type: 'mathInline', attrs: { latex: '' } }).run()
      },
    }
  },
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
