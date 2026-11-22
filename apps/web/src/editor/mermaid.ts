// Reference diagram UI on the shared safe Mermaid renderer and schema.
import { commandMatches } from '../shortcutCommands'
import { InputRule } from '@tiptap/core'
import { createSectionDragSurface } from './snapSurface'
import { t as tr } from '../i18n'
import { cleanMermaid, renderMermaid } from '@nevis/editor'
import { Mermaid as MermaidSpec, MAX_SOURCE } from '@nevis/schema'
import { openLightbox } from './lightbox'
export { looksLikeMermaid, cleanMermaid } from '@nevis/editor'

const MERMAID_SAMPLE = 'flowchart TD\n  A[شروع] --> B{شرط؟}\n  B -- بله --> C[انجام بده]\n  B -- نه --> D[پایان]\n  C --> D'

type Rendered = { svg: string } | { error: string }
export async function renderDiagram(code: string, dark?: boolean): Promise<Rendered> {
  const result = await renderMermaid(code, dark ?? (document.documentElement.dataset.theme === 'dark'))
  return result.ok ? { svg: result.svg } : { error: tr('Could not render the diagram. Check its source.') }
}

const views = new Set<(force?: boolean) => Promise<void> | void>()
/** Draws every diagram on the page now, even those far off screen, in the current theme (used before printing). */
export const drawAllDiagrams = () => Promise.all([...views].map((v) => v(true))).then(() => {})
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
export const MermaidBlock = MermaidSpec.extend({
  priority: 200,
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
      let destroyed = false,
        previewTimer = 0,
        openTimer = 0,
        visibilityTimer = 0,
        watchFrame = 0
      let editBase = node.attrs.code
      const dom = document.createElement('div')
      dom.className = 'mermaid-block'
      dom.contentEditable = 'false'
      dom.setAttribute('dir', 'ltr')
      const view = document.createElement('div')
      view.className = 'mermaid-view'
      const bar = document.createElement('div')
      bar.className = 'mermaid-bar ds-toolbar'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'ds-btn ds-btn--sm ds-btn--ghost'
      edit.textContent = tr('Edit code')

      // enlarge: opens the zoom/pan viewer with the current picture
      const big = document.createElement('button')
      big.type = 'button'
      big.textContent = `⤢ ${tr('Enlarge')}`
      big.hidden = true
      big.className = 'mm-big ds-btn ds-btn--sm ds-btn--ghost'
      big.onclick = () => {
        const svg = view.querySelector('svg')
        if (svg) openLightbox({ svg: svg.outerHTML, alt: tr('Diagram') })
      }

      // convert to code: the same text as an ordinary code block (it can be turned back with "Show as diagram")
      const toCode = document.createElement('button')
      toCode.type = 'button'
      toCode.className = 'ds-btn ds-btn--sm ds-btn--ghost'
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
        return paint(cur.attrs.code)
      }
      const redraw = (force?: boolean) => {
        if (force) near = true
        return draw()
      }
      views.add(redraw)
      let reported = false
      visible.set(dom, (on) => {
        reported = true
        near = on
        if (on && stale) draw()
      })
      let obs: IntersectionObserver | undefined
      watchFrame = requestAnimationFrame(() => {
        if (!destroyed) obs = watch(dom)
      })
      // a page that is not being shown (hidden window, background tab) never reports visibility: draw anyway so printing/export still work
      visibilityTimer = window.setTimeout(() => {
        if (destroyed || reported || !dom.isConnected) return
        near = true
        draw()
      }, 1500)
      const commit = (value: string | null) => {
        if (destroyed || editor.isDestroyed) return
        clearTimeout(previewTimer)
        token++
        editing = false
        dom.classList.remove('editing')
        panel.remove()
        const pos = getPos()
        if (value !== null && cur.attrs.code !== editBase) {
          window.dispatchEvent(new CustomEvent('layout-message', { detail: tr('The diagram changed while it was open. The newer page content was kept.') }))
          draw()
        } else if (pos != null && editor.isEditable && value !== null && value !== cur.attrs.code) {
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, code: value.slice(0, MAX_SOURCE) }))
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
          previewTimer = window.setTimeout(() => {
            if (!destroyed && editing) void paint(ta.value)
          }, 350)
        }
        ta.onkeydown = (e) => {
          e.stopPropagation()
          if (commandMatches(e, 'Cancel editing a formula or diagram')) (e.preventDefault(), (done = true), commit(null))
          else if (commandMatches(e, 'Save a diagram')) (e.preventDefault(), (done = true), commit(ta.value))
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
          clearTimeout(previewTimer)
          clearTimeout(openTimer)
          clearTimeout(visibilityTimer)
          cancelAnimationFrame(watchFrame)
          token++ // Discard a render which resolves after its block has been removed/moved.
          views.delete(redraw)
          obs?.unobserve(dom)
          visible.delete(dom)
        },
      }
    }
  },
})
