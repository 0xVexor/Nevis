// Math (KaTeX), diagrams (Mermaid): rendered nodes with an edit field. The libraries are loaded on first use (dynamic import), so a page
// without them does not pay for them. SAFETY: synced content is untrusted: KaTeX `trust` stays off; Mermaid runs with
// `securityLevel: 'strict'` (its own sanitizer; no scripts, no click handlers, no raw HTML labels).
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { MAX_SOURCE, MathBlock as MathBlockSpec, MathInline as MathInlineSpec, Mermaid as MermaidSpec } from '@nevis/schema'
import { cleanMermaid } from '../mermaidText'
import { S } from '../strings'

type Katex = typeof import('katex').default
let katex: Promise<Katex> | null = null
const loadKatex = () => (katex ??= import('katex').then(m => m.default))
export async function renderMath(latex: string, display: boolean): Promise<{ html: string; ok: boolean }> {
  try {
    const k = await loadKatex()
    return { html: k.renderToString(latex, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500, output: 'htmlAndMathml' }), ok: true }
  } catch { return { html: '', ok: false } }
}

/** A small inline editor over an atom: Enter or blur commits, Escape cancels. `multiline`: Enter inserts a newline, Mod-Enter commits. */
function editField(initial: string, multiline: boolean, commit: (v: string) => void, cancel: () => void): HTMLElement {
  const f = document.createElement(multiline ? 'textarea' : 'input') as HTMLTextAreaElement | HTMLInputElement
  f.className = 'atom-edit'
  f.value = initial
  f.setAttribute('dir', 'ltr')
  f.maxLength = MAX_SOURCE
  if (f instanceof HTMLTextAreaElement) f.rows = Math.min(12, Math.max(3, initial.split('\n').length + 1))
  let done = false
  const finish = (ok: boolean) => { if (done) return; done = true; ok ? commit(f.value) : cancel() }
  f.addEventListener('keydown', (e: Event) => {
    const k = e as KeyboardEvent
    if (k.key === 'Escape') { e.preventDefault(); finish(false) }
    else if (k.key === 'Enter' && (!multiline || k.metaKey || k.ctrlKey)) { e.preventDefault(); finish(true) }
    e.stopPropagation()
  })
  f.addEventListener('blur', () => finish(true))
  queueMicrotask(() => f.focus())
  return f
}

function atomView(opts: { tag: 'div' | 'span'; cls: string; attr: 'latex' | 'code'; multiline: boolean; draw: (el: HTMLElement, value: string, token: number) => Promise<void> | void; title: string }) {
  return ({ node, editor, getPos }: NodeViewRendererProps) => {
    let cur = node
    const dom = document.createElement(opts.tag)
    dom.className = opts.cls
    dom.contentEditable = 'false'
    dom.title = opts.title
    let editing = false
    let token = 0
    const show = () => { dom.textContent = ''; void opts.draw(dom, String(cur.attrs[opts.attr]), ++token) }
    show()
    const open = () => {
      if (!editor.isEditable || editing) return
      editing = true
      dom.textContent = ''
      dom.append(editField(String(cur.attrs[opts.attr]), opts.multiline, v => {
        editing = false
        const pos = getPos()
        if (pos != null && v !== cur.attrs[opts.attr]) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, [opts.attr]: v.slice(0, MAX_SOURCE) }))
        show()
        editor.commands.focus()
      }, () => { editing = false; show(); editor.commands.focus() }))
    }
    dom.addEventListener('dblclick', open)
    dom.addEventListener('click', () => { if (!editing && String(cur.attrs[opts.attr]) === '') open() }) // an empty one opens at once
    return {
      dom,
      update: (n: PMNode) => { if (n.type !== cur.type) return false; const changed = n.attrs[opts.attr] !== cur.attrs[opts.attr]; cur = n; if (changed && !editing) show(); return true },
      stopEvent: (e: Event) => editing || e.type === 'dblclick',
      ignoreMutation: () => true,
      selectNode: () => dom.classList.add('selected'),
      deselectNode: () => dom.classList.remove('selected'),
    }
  }
}

const drawMath = (display: boolean) => async (el: HTMLElement, latex: string, token: number) => {
  if (!latex) { el.textContent = '∑'; el.classList.add('empty'); return }
  el.classList.remove('empty')
  const r = await renderMath(latex, display)
  if (el.isConnected === false && token === 0) return
  if (r.ok) el.innerHTML = r.html // KaTeX's own output (trust off)
  else { el.textContent = latex; el.classList.add('error'); el.title = S.formulaError }
}

export const MathBlock = MathBlockSpec.extend({ addNodeView: () => atomView({ tag: 'div', cls: 'math-block', attr: 'latex', multiline: true, draw: drawMath(true), title: S.editFormula }) })
export const MathInline = MathInlineSpec.extend({ addNodeView: () => atomView({ tag: 'span', cls: 'math-inline', attr: 'latex', multiline: false, draw: drawMath(false), title: S.editFormula }) })

type Mermaid = typeof import('mermaid').default
let mermaid: Promise<Mermaid> | null = null
const loadMermaid = () => (mermaid ??= import('mermaid').then(m => { m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' }); return m.default }))
let seq = 0
let renderQueue: Promise<unknown> = Promise.resolve()
let renderedTheme = 'default'
export function renderMermaid(code: string, dark = false): Promise<{ svg: string; ok: boolean }> {
  const render = async () => {
    const id = `mmd-${Date.now()}-${++seq}`
    try {
      const m = await loadMermaid()
      const theme = dark ? 'dark' : 'default'
      if (renderedTheme !== theme) {
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })
        renderedTheme = theme
      }
      const source = cleanMermaid(code)
      await m.parse(source)
      const { svg } = await m.render(id, source)
      return { svg, ok: true }
    } catch {
      document.getElementById(`d${id}`)?.remove()
      document.getElementById(id)?.remove()
      return { svg: '', ok: false }
    }
  }
  // Mermaid uses global scratch state. Concurrent node views must not render over each other.
  const result = renderQueue.then(render, render)
  renderQueue = result
  return result
}

const drawMermaid = async (el: HTMLElement, code: string, token: number) => {
  if (!code.trim()) { el.textContent = '◇'; el.classList.add('empty'); return }
  el.classList.remove('empty', 'error')
  const r = await renderMermaid(code)
  if (!r.ok) { el.classList.add('error'); el.textContent = S.diagramError; const pre = document.createElement('pre'); pre.textContent = code; el.append(pre); return }
  el.innerHTML = r.svg // produced by Mermaid under securityLevel 'strict'
  void token
}
export const Mermaid = MermaidSpec.extend({ addNodeView: () => atomView({ tag: 'div', cls: 'mermaid-block', attr: 'code', multiline: true, draw: drawMermaid, title: S.editDiagram }) })
