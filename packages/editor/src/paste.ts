// Paste (Markdown, a web page, Word, an AI chat). Pasted content is UNTRUSTED: it is cleaned before ProseMirror parses it, and the
// schema filters attributes again when it parses (`isSafeHref`, `safeImageSrc`). Browser-only (DOMParser).
import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { isSafeHref, safeImageSrc } from '@nevis/schema'
import { marked } from 'marked'
import { looksLikeMermaid } from './mermaidText'
import { explain, sniffBlob } from './attachments'
import { optionsOf } from './options'

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
export function markdownToHtml(md: string, clean = true): string {
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
  return clean ? cleanPastedHtml(doc.body.innerHTML) : doc.body.innerHTML
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

/** Read public images using the image policy, which is narrower than granting cross-origin fetch to the editor. */
function captureRemoteImage(url: string): Promise<Blob | null> {
  return new Promise(resolve => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    const finish = (result: Blob | null) => {
      clearTimeout(timer)
      image.onload = image.onerror = null
      image.removeAttribute('src')
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), 5_000)
    image.onerror = () => finish(null)
    image.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = image
      if (!width || !height || width * height > 20_000_000) { finish(null); return }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) { finish(null); return }
      try {
        context.drawImage(image, 0, 0)
        canvas.toBlob(finish, 'image/png')
      } catch { finish(null) }
    }
    image.src = url
  })
}

/** Capture clipboard image bytes before inserting references. Failed downloads retain their original URL for repair. */
function embeddedImages(editor: Editor, html: string, files: File[]): { html: string; pending: Promise<void>[] } {
  const port = optionsOf(editor).attachments
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pending: Promise<void>[] = []
  if (!port) return { html, pending }
  doc.querySelectorAll(DROP).forEach(el => el.remove())
  const images = Array.from(doc.querySelectorAll('img[src]'))
  const imageFiles = files.filter(file => file.type.startsWith('image/'))
  // Only pair when the mapping is unambiguous; otherwise preserve the URLs.
  const paired = imageFiles.length === images.length ? imageFiles : []
  images.forEach((img, index) => {
    const source = img.getAttribute('src') ?? ''
    const file = paired[index]
    const data = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([a-z0-9+/=\s]+)$/i.exec(source)
    const safe = safeImageSrc(source)
    let publicUrl = false
    if (safe) {
      const host = new URL(safe).hostname
      publicUrl = host.includes('.') && !/^(?:\d+\.){3}\d+$/.test(host) && !host.endsWith('.local') && !host.endsWith('.localhost')
    }
    if (!file && !data && !publicUrl) return
    pending.push((async () => {
      try {
        let blob: Blob
        if (file) blob = file
        else if (data) {
          if (data[1]!.length > Math.ceil(port.maxBytes / 3) * 4 + 8) return
          const binary = atob(data[1]!)
          blob = new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))])
        } else {
          const captured = await captureRemoteImage(safe)
          if (!captured) return
          blob = captured
        }
        if (blob.size > port.maxBytes) return
        const mime = await sniffBlob(blob)
        if (!mime) return
        const ref = await port.add(blob, img.getAttribute('alt') || file?.name || 'image', mime)
        const figure = doc.createElement('figure')
        figure.setAttribute('data-type', 'image')
        figure.setAttribute('data-alt', img.getAttribute('alt') ?? '')
        figure.setAttribute('data-title', img.getAttribute('title') ?? '')
        figure.setAttribute('data-blob', ref.blob)
        figure.setAttribute('data-mime', ref.mime)
        figure.setAttribute('data-size', String(ref.size))
        img.replaceWith(figure)
      } catch (error) {
        // CORS and expired URLs are common; the original source remains available for repair.
        if (file || data) explain(editor, error)
      }
    })())
  })
  return { get html() { return doc.body.innerHTML }, pending }
}

function cleanRichHtml(html: string): string {
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
}

function insertWithEmbeddedImages(editor: Editor, html: string, files: File[]): boolean {
  const result = embeddedImages(editor, html, files)
  if (!result.pending.length) return false
  let bookmark = editor.state.selection.getBookmark()
  const map = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => { bookmark = bookmark.map(transaction.mapping) }
  editor.on('transaction', map)
  void Promise.all(result.pending).then(() => {
    editor.off('transaction', map)
    if (editor.isDestroyed) return
    const selection = bookmark.resolve(editor.state.doc)
    editor.chain().insertContentAt({ from: selection.from, to: selection.to }, cleanRichHtml(result.html)).run()
  })
  return true
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
          transformPastedHTML: cleanRichHtml,
          handlePaste: (view, event) => {
            const cd = event.clipboardData
            if (!cd) return false
            const inCode = view.state.selection.$from.parent.type.name === 'codeBlock'
            const raw = cd.getData('text/plain')
            if (!cd.getData('text/html') && !inCode && looksLikeMermaid(raw)) { // raw Mermaid text -> one diagram block, not a pile of paragraphs
              editor.chain().focus().insertContent({ type: 'mermaid', attrs: { code: raw.trim() } }).run()
              return true
            }
            const files = Array.from(cd.files)
            const html = cd.getData('text/html')
            if (html) {
              if (insertWithEmbeddedImages(editor, html, files)) return true
              return false // ProseMirror handles rich content after transformPastedHTML
            }
            if (inCode) return false // keep code literal
            if (!raw || !looksLikeMarkdown(raw)) return false
            const markdownHtml = markdownToHtml(raw, false)
            if (!insertWithEmbeddedImages(editor, markdownHtml, files)) editor.chain().focus().insertContent(cleanPastedHtml(markdownHtml)).run()
            return true
          },
        },
      }),
    ]
  },
})
