import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { marked } from 'marked'
import { looksLikeMermaid } from './mermaid'

// Block-level markers that make plain text "look like Markdown". Inline-only marks (**x**, `x`) are already
// handled by the editor's own input rules on paste, so they alone do not trigger conversion.
const BLOCK_MD = /^(\$\$|<details|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.+\||---+\s*$|\[[ xX]\]\s)/m
const INLINE_MD = /\*\*[^*\n]+\*\*|(^|\s)`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/

const looksLikeMarkdown = (t: string) => BLOCK_MD.test(t) || INLINE_MD.test(t)

/** Markdown -> HTML that the editor schema understands (task lists use TipTap's data attributes). */
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const CALLOUT_ICONS = ['💡', '⚠️', '❗', '✅', 'ℹ️', '🔥', '📌']
const ALERTS: Record<string, string> = {
  NOTE: 'ℹ️', INFO: 'ℹ️', ABSTRACT: '📋', SUMMARY: '📋', TLDR: '📋', TODO: '☑️', TIP: '💡', HINT: '💡', IMPORTANT: '❗', SUCCESS: '✅', CHECK: '✅', DONE: '✅',
  QUESTION: '❓', HELP: '❓', FAQ: '❓', WARNING: '⚠️', CAUTION: '🔥', ATTENTION: '⚠️', FAILURE: '❌', FAIL: '❌', MISSING: '❌', DANGER: '🔥', ERROR: '🔥',
  BUG: '🐞', EXAMPLE: '📌', QUOTE: '💬', CITE: '💬',
}

/** `$$..$$` and `$..$` outside code spans/fences -> placeholders the editor's math nodes parse. */
function withMath(md: string): string {
  return md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2) return part // code
      return part
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, l) => `\n\n<div data-type="math-block" data-latex="${attr(l.trim())}"></div>\n\n`)
        .replace(/(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g, (_, l) => `<span data-type="math-inline" data-latex="${attr(l)}"></span>`)
    })
    .join('')
}

export function markdownToHtml(md: string): string {
  const html = marked.parse(withMath(md), { gfm: true, breaks: false, async: false }) as string
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // ```mermaid fences -> diagram block (not a code block)
  doc.querySelectorAll('pre > code.language-mermaid').forEach((code) => {
    const d = doc.createElement('div')
    d.setAttribute('data-type', 'mermaid')
    d.setAttribute('data-code', code.textContent ?? '')
    code.parentElement!.replaceWith(d)
  })
  // <details><summary>x</summary>rest</details> -> toggle (title paragraph first)
  doc.querySelectorAll('details').forEach((d) => {
    const sum = d.querySelector(':scope > summary')
    const t = doc.createElement('div')
    t.setAttribute('data-type', 'toggle')
    const p = doc.createElement('p')
    p.innerHTML = sum?.innerHTML ?? ''
    sum?.remove()
    t.append(p, ...Array.from(d.childNodes))
    d.replaceWith(t)
  })
  // > 💡 text  /  > [!NOTE] text -> callout
  doc.querySelectorAll('blockquote').forEach((q) => {
    const first = q.querySelector(':scope > p')
    const txt = first?.textContent?.trimStart() ?? ''
    const alert = txt.match(/^\[!(\w+)\][+-]?[ \t]*/) // GitHub alerts and Obsidian callouts (`> [!info]- Title`)
    const emoji = alert ? (ALERTS[alert[1].toUpperCase()] ?? 'ℹ️') : CALLOUT_ICONS.find((e) => txt.startsWith(e))
    if (!first || !emoji) return
    // strip the marker from the first text node
    const w = doc.createTreeWalker(first, NodeFilter.SHOW_TEXT)
    const n = w.nextNode()
    if (n) n.textContent = (n.textContent ?? '').trimStart().replace(alert ? /^\[!\w+\][+-]?[ \t]*/ : emoji, '').trimStart()
    const c = doc.createElement('div')
    c.setAttribute('data-type', 'callout')
    c.setAttribute('data-emoji', emoji)
    c.append(...Array.from(q.childNodes))
    q.replaceWith(c)
  })
  doc.querySelectorAll('li > input[type="checkbox"]').forEach((box) => {
    const li = box.parentElement!
    li.setAttribute('data-type', 'taskItem')
    li.setAttribute('data-checked', (box as HTMLInputElement).checked ? 'true' : 'false')
    li.parentElement?.setAttribute('data-type', 'taskList')
    box.remove()
  })
  // TipTap's taskItem wants block content; <li>text</li> is wrapped into a paragraph by the schema.
  return doc.body.innerHTML
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          // rich paste (a web page, a chat): a code block that holds Mermaid becomes a diagram block, not code
          transformPastedHTML: (html) => {
            if (!/<pre[\s>]/i.test(html)) return html
            const doc = new DOMParser().parseFromString(html, 'text/html')
            let changed = false
            doc.querySelectorAll('pre').forEach((pre) => {
              const code = pre.textContent ?? ''
              if (pre.querySelector('code.language-mermaid') || looksLikeMermaid(code)) {
                const d = doc.createElement('div')
                d.setAttribute('data-type', 'mermaid')
                d.setAttribute('data-code', code.replace(/\n$/, ''))
                pre.replaceWith(d)
                changed = true
              }
            })
            return changed ? doc.body.innerHTML : html
          },
          handlePaste: (view, event) => {
            const cd = event.clipboardData
            if (!cd) return false
            if (cd.files.length) return false // images are handled by ImageFiles
            const inCode = view.state.selection.$from.parent.type.name === 'codeBlock'
            const raw = cd.getData('text/plain')
            // raw Mermaid text (no fences) -> one diagram block instead of a pile of paragraphs
            if (!cd.getData('text/html') && !inCode && looksLikeMermaid(raw)) {
              editor.chain().focus().insertContent({ type: 'mermaid', attrs: { code: raw.trim() } }).run()
              return true
            }
            if (cd.getData('text/html')) return false // real rich content: let ProseMirror handle it
            if (inCode) return false // keep code literal
            const text = cd.getData('text/plain')
            if (!text || !looksLikeMarkdown(text)) return false
            editor.chain().focus().insertContent(markdownToHtml(text)).run()
            return true
          },
        },
      }),
    ]
  },
})
