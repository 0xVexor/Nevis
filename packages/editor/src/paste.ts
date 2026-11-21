// Paste (Markdown, a web page, Word, an AI chat). Pasted content is UNTRUSTED: it is cleaned before ProseMirror parses it, and the
// schema filters attributes again when it parses (`isSafeHref`, `safeImageSrc`). Browser-only (DOMParser).
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { isSafeHref, safeImageSrc } from '@nevis/schema'
import { marked } from 'marked'
import { looksLikeMermaid } from './mermaidText'

// ---------------------------------------------------------------------------------------------------------------- Markdown

// Block-level markers that make plain text "look like Markdown". Inline-only marks (**x**, `x`) are already handled by the editor's
// own input rules on paste, so they alone do not trigger conversion.
const BLOCK_MD = /^(\$\$|<details|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.+\||---+\s*$|\[[ xX]\]\s)/m
const INLINE_MD = /\*\*[^*\n]+\*\*|(^|\s)`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/
export const looksLikeMarkdown = (t: string): boolean => BLOCK_MD.test(t) || INLINE_MD.test(t)

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** callout icon names (the editor's own stroke icons); an emoji at the start of a quote or a GitHub/Obsidian alert picks one */
const EMOJI_ICON: Record<string, string> = { '💡': 'bulb', '⚠️': 'warning', '❗': 'warning', '✅': 'check', 'ℹ️': 'info', '🔥': 'flame', '📌': 'pin' }
const ALERT_ICON: Record<string, string> = {
  NOTE: 'info', INFO: 'info', ABSTRACT: 'info', SUMMARY: 'info', TLDR: 'info', TODO: 'check', TIP: 'bulb', HINT: 'bulb', IMPORTANT: 'warning', SUCCESS: 'check', CHECK: 'check', DONE: 'check',
  QUESTION: 'bell', HELP: 'bell', FAQ: 'bell', WARNING: 'warning', CAUTION: 'flame', ATTENTION: 'warning', FAILURE: 'flame', FAIL: 'flame', MISSING: 'flame', DANGER: 'flame', ERROR: 'flame', BUG: 'flame', EXAMPLE: 'pin', QUOTE: 'pin', CITE: 'pin',
}

/** `$$..$$` and `$..$` outside code spans/fences become placeholders the editor's math nodes parse. */
function withMath(md: string): string {
  return md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2) return part // code
      return part
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, l: string) => `\n\n<div data-type="math-block" data-latex="${attr(l.trim())}"></div>\n\n`)
        .replace(/(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g, (_, l: string) => `<span data-type="math-inline" data-latex="${attr(l)}"></span>`)
    })
    .join('')
}

/** Markdown -> HTML that the editor schema understands (task lists use TipTap's data attributes). The result is cleaned too. */
export function markdownToHtml(md: string): string {
  const html = marked.parse(withMath(md), { gfm: true, breaks: false, async: false }) as string
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll('pre > code.language-mermaid').forEach(code => { // a ```mermaid fence is a diagram block, not code
    const d = doc.createElement('div')
    d.setAttribute('data-type', 'mermaid')
    d.setAttribute('data-code', code.textContent ?? '')
    code.parentElement!.replaceWith(d)
  })
  doc.querySelectorAll('details').forEach(d => { // <details><summary>x</summary>rest</details> -> toggle (title paragraph first)
    const sum = d.querySelector(':scope > summary')
    const t = doc.createElement('div')
    t.setAttribute('data-type', 'toggle')
    const p = doc.createElement('p')
    p.innerHTML = sum?.innerHTML ?? ''
    sum?.remove()
    t.append(p, ...Array.from(d.childNodes))
    d.replaceWith(t)
  })
  doc.querySelectorAll('blockquote').forEach(q => { // > 💡 text  /  > [!NOTE] text -> callout
    const first = q.querySelector(':scope > p')
    const txt = first?.textContent?.trimStart() ?? ''
    const alert = txt.match(/^\[!(\w+)\][+-]?[ \t]*/)
    const emoji = alert ? undefined : Object.keys(EMOJI_ICON).find(e => txt.startsWith(e))
    const icon = alert ? (ALERT_ICON[alert[1]!.toUpperCase()] ?? 'info') : emoji ? EMOJI_ICON[emoji] : undefined
    if (!first || !icon) return
    const n = doc.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    if (n) n.textContent = (n.textContent ?? '').trimStart().replace(alert ? /^\[!\w+\][+-]?[ \t]*/ : emoji!, '').trimStart()
    const c = doc.createElement('div')
    c.setAttribute('data-type', 'callout')
    c.setAttribute('data-icon', icon)
    c.append(...Array.from(q.childNodes))
    q.replaceWith(c)
  })
  doc.querySelectorAll('li input[type="checkbox"]').forEach(box => { // a task item is `li > input`, or `li > p > input` in a loose list
    const li = box.closest('li')!
    li.setAttribute('data-type', 'taskItem')
    li.setAttribute('data-checked', (box as HTMLInputElement).checked ? 'true' : 'false')
    li.parentElement?.setAttribute('data-type', 'taskList')
    box.remove()
  })
  return cleanPastedHtml(doc.body.innerHTML)
}

// ---------------------------------------------------------------------------------------------------------------- cleaning

const DROP = 'script,style,meta,link,iframe,object,embed,form,input,button,select,textarea,svg,math,audio,video,source,template,noscript,base,head,title,xml'
const KEEP: Record<string, Set<string>> = {
  a: new Set(['href', 'title']), img: new Set(['src', 'alt', 'title']), td: new Set(['colspan', 'rowspan', 'dir']), th: new Set(['colspan', 'rowspan', 'dir']),
  ol: new Set(['start']), li: new Set(['dir']), code: new Set(['class']), pre: new Set(['class']),
}
const GLOBAL = new Set(['dir'])

/** Strips what must not come in from a web page, Word or a chat: scripts, styles, event handlers, unsafe links, `data:` images
 *  (which would make one op huge), classes and Word's markup. Our own `data-*` attributes survive so copy/paste inside the app works. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(DROP).forEach(el => el.remove())
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n)
  comments.forEach(c => c.parentNode?.removeChild(c)) // Word's conditional comments
  doc.body.querySelectorAll('*').forEach(el => {
    const tag = el.tagName.toLowerCase()
    if (tag.includes(':')) { el.replaceWith(...Array.from(el.childNodes)); return } // <o:p> and the like: keep the text
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase()
      const keep = name.startsWith('data-') || GLOBAL.has(name) || KEEP[tag]?.has(name)
      if (!keep || name.startsWith('on')) el.removeAttribute(a.name)
    }
    if (tag === 'a') { const h = el.getAttribute('href'); if (h !== null && !isSafeHref(h)) el.removeAttribute('href') }
    if (tag === 'img') {
      const src = safeImageSrc(el.getAttribute('src') ?? '')
      if (src) el.setAttribute('src', src); else el.setAttribute('src', '') // a placeholder, never a data: URL
    }
    if (el.hasAttribute('data-src')) el.setAttribute('data-src', safeImageSrc(el.getAttribute('data-src') ?? ''))
  })
  return doc.body.innerHTML
}

// ---------------------------------------------------------------------------------------------------------------- extension

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          // rich paste (a web page, Word, a chat): clean it; a code block that holds Mermaid becomes a diagram block, not code
          transformPastedHTML: html => {
            const doc = new DOMParser().parseFromString(cleanPastedHtml(html), 'text/html')
            doc.querySelectorAll('pre').forEach(pre => {
              const code = pre.textContent ?? ''
              if (pre.querySelector('code.language-mermaid') || looksLikeMermaid(code)) {
                const d = doc.createElement('div')
                d.setAttribute('data-type', 'mermaid')
                d.setAttribute('data-code', code.replace(/\n$/, ''))
                pre.replaceWith(d)
              }
            })
            return doc.body.innerHTML
          },
          handlePaste: (view, event) => {
            const cd = event.clipboardData
            if (!cd) return false
            if (cd.files.length) return false // images are handled by ImageFiles
            const inCode = view.state.selection.$from.parent.type.name === 'codeBlock'
            const raw = cd.getData('text/plain')
            if (!cd.getData('text/html') && !inCode && looksLikeMermaid(raw)) { // raw Mermaid text -> one diagram block, not a pile of paragraphs
              editor.chain().focus().insertContent({ type: 'mermaid', attrs: { code: raw.trim() } }).run()
              return true
            }
            if (cd.getData('text/html')) return false // real rich content: ProseMirror handles it (after transformPastedHTML)
            if (inCode) return false // keep code literal
            if (!raw || !looksLikeMarkdown(raw)) return false
            editor.chain().focus().insertContent(markdownToHtml(raw)).run()
            return true
          },
        },
      }),
    ]
  },
})
