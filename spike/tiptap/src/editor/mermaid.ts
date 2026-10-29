import { Node, InputRule, mergeAttributes } from '@tiptap/core'
import { createSectionDragSurface } from './snapSurface'
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

type Rendered = { svg: string } | { error: string }

// Mermaid renders into shared scratch elements and keeps global state, so renders run strictly one after another
// (concurrent ones used to trip over each other and show a flash of errors). Results are cached per code + theme.
let chain: Promise<unknown> = Promise.resolve()
const cache = new Map<string, Rendered>()
const CACHE_MAX = 200

/** Mermaid draws its "Syntax error" bomb (and a scratch container) straight into <body> and leaves it there. */
const sweep = (id: string) => document.querySelectorAll(`body > #d${id}, body > #${id}, body > [id^="dmmd-"], body > [id^="mmd-"]`).forEach((el) => el.remove())

const remember = (key: string, r: Rendered) => {
  cache.delete(key)
  cache.set(key, r)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

export function renderDiagram(code: string): Promise<Rendered> {
  const text = cleanMermaid(code)
  const run = async (): Promise<Rendered> => {
    const m = await mermaid()
    const key = `${theme}\n${text}`
    const hit = cache.get(key)
    if (hit) return hit
    const id = `mmd-${++seq}` // this render's own id, so a failure cleans up after itself and nobody else
    let r: Rendered
    try {
      await m.parse(text) // a syntax error is found here, before mermaid draws anything into the page
      r = { svg: (await m.render(id, text)).svg }
    } catch (e) {
      sweep(id)
      r = { error: String((e as Error)?.message ?? e).split('\n')[0] }
    }
    remember(key, r) // errors are cached too: the same broken code is not parsed again on every redraw
    return r
  }
  const out = chain.then(run, run)
  chain = out.catch(() => {})
  return out
}

const views = new Set<() => void>()
const themeKey = () => `${document.documentElement.dataset.theme ?? ''}|${getComputedStyle(document.body).colorScheme}`
let lastTheme = themeKey()
// diagrams carry the theme in their SVG, so they are redrawn when the theme changes (not on every other style change)
new MutationObserver(() => {
  const now = themeKey()
  if (now === lastTheme) return
  lastTheme = now
  views.forEach((v) => v())
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })

// Diagrams far from the screen are not drawn: a page with dozens of them opens at once and fills in as it is scrolled.
const visible = new WeakMap<Element, (on: boolean) => void>()
// rootMargin only widens the viewport, not a scroll container, so the observer's root is the nearest scrolling ancestor
const watchers = new Map<Element | null, IntersectionObserver>()
const scroller = (el: Element): Element | null => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p
  return null
}
const watch = (el: Element) => {
  const root = scroller(el)
  let w = watchers.get(root)
  if (!w) watchers.set(root, (w = new IntersectionObserver((entries) => entries.forEach((e) => visible.get(e.target)?.(e.isIntersecting)), { root, rootMargin: '400px 0px' })))
  w.observe(el)
  return w
}

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
      let destroyed = false, previewTimer = 0, openTimer = 0, visibilityTimer = 0, watchFrame = 0
      let editBase = node.attrs.code
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
      const surface = createSectionDragSurface(tr('Move diagram'), tr('Drag this area to move the whole block.'))
      dom.append(surface, bar, view)

      const paint = async (code: string, into: HTMLElement = view) => {
        if (destroyed) return
        const mine = ++token
        if (!code.trim()) {
          if (into === view) big.hidden = true
          into.textContent = tr('Empty diagram — click “Edit code”')
          into.className = into === view ? 'mermaid-view empty' : into.className
          return
        }
        const r = await renderDiagram(code)
        if (destroyed || mine !== token) return // a newer render superseded this one
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
      // drawn only while near the screen; changes that arrive while it is far away are applied when it comes back
      let near = false
      let stale = true
      const draw = () => {
        if (editing) return
        if (!near) return void (stale = true)
        stale = false
        void paint(cur.attrs.code)
      }
      const redraw = () => draw()
      views.add(redraw)
      let reported = false
      visible.set(dom, (on) => {
        reported = true
        near = on
        if (on && stale) draw()
      })
      let obs: IntersectionObserver | undefined
      watchFrame = requestAnimationFrame(() => { if (!destroyed) obs = watch(dom) })
      // a page that is not being shown (hidden window, background tab) never reports visibility: draw anyway so printing/export still work
      visibilityTimer = window.setTimeout(() => {
        if (destroyed || reported || !dom.isConnected) return
        near = true
        draw()
      }, 1500)
      const commit = (value: string | null) => {
        if (destroyed || editor.isDestroyed) return
        clearTimeout(previewTimer); token++
        editing = false
        dom.classList.remove('editing')
        panel.remove()
        const pos = getPos()
        if (value !== null && cur.attrs.code !== editBase) {
          window.dispatchEvent(new CustomEvent('layout-message', { detail: tr('The diagram changed while it was open. The newer page content was kept.') }))
          draw()
        } else if (pos != null && editor.isEditable && value !== null && value !== cur.attrs.code) {
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, code: value }))
        } else draw()
        editor.view.focus()
      }

      const panel = document.createElement('div')
      panel.className = 'mermaid-edit'
      const startEdit = () => {
        if (editing || destroyed || editor.isDestroyed || !editor.isEditable) return
        editing = true
        editBase = cur.attrs.code
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
        ta.oninput = () => {
          ta.rows = Math.max(5, ta.value.split('\n').length + 1)
          window.clearTimeout(previewTimer)
          previewTimer = window.setTimeout(() => { if (!destroyed && editing) void paint(ta.value) }, 350)
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
      if (!node.attrs.code && editor.isEditable) openTimer = window.setTimeout(startEdit, 0)

      return {
        dom,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          draw()
          return true
        },
        stopEvent: (event) => editing || (event.target instanceof globalThis.Node && (bar.contains(event.target) || surface.contains(event.target))),
        ignoreMutation: () => true,
        destroy: () => {
          destroyed = true
          clearTimeout(previewTimer); clearTimeout(openTimer); clearTimeout(visibilityTimer); cancelAnimationFrame(watchFrame)
          token++ // Discard a render which resolves after its block has been removed/moved.
          views.delete(redraw)
          obs?.unobserve(dom)
          visible.delete(dom)
        },
      }
    }
  },
})
