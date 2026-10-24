import katex from 'katex'
import { Editor } from '@tiptap/core'
import { extensions } from './editor/extensions'
import { renderDiagram } from './editor/mermaid'
import { urlFor } from './attachments'

/** ProseMirror doc (or array of blocks) -> HTML via the real schema, without mounting an editor. */
export function docToHtml(doc: any): string {
  const content = Array.isArray(doc) ? { type: 'doc', content: doc } : doc
  const ed = new Editor({ extensions, content })
  const html = ed.getHTML()
  ed.destroy()
  return html
}

/**
 * Makes HTML produced by docToHtml look like the page: stored images, formulas and diagrams are
 * filled in (those nodes serialise to placeholders that only carry their source).
 */
export async function hydrate(root: HTMLElement) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="att:"]'))) {
    const u = await urlFor(img.getAttribute('src')!)
    if (u) img.src = u
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-type="math-inline"], [data-type="math-block"]'))) {
    try {
      katex.render(el.getAttribute('data-latex') ?? '', el, { displayMode: el.getAttribute('data-type') === 'math-block', throwOnError: false })
    } catch {
      /* leave the LaTeX source visible */
    }
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-type="mermaid"]'))) {
    const r = await renderDiagram(el.getAttribute('data-code') ?? '')
    if ('svg' in r) (el.innerHTML = r.svg, el.classList.add('mermaid-view'))
  }
}
