// ProseMirror JSON -> Markdown, one way (ADR-0009 §3). One implementation, for the desktop mirror and the web's "download Markdown". It
// never reads Markdown back. What Markdown cannot say is kept as the HTML the ADR names (direction, columns, toggles), so a reader with any
// Markdown viewer sees the text; the loss is listed in docs/formats/markdown-mirror.md.
import { isSafeHref, type PMJson } from '@nevis/schema'

export interface MdContext {
  /** the title of a page a link points to */
  titleOf?: (id: string) => string
  /** where an attachment is written, relative to the file (default `attachments/<hash>`) */
  attachment?: (hash: string, name?: string) => string
  /** the direction of the page: a block with another direction is wrapped in a `<div dir>` */
  pageDir?: 'rtl' | 'ltr' | 'auto'
}

const esc = (s: string) => s.replace(/([\\`*_{}\[\]<>#|])/g, '\\$1')
const attr = (n: PMJson, k: string) => n.attrs?.[k]

function inline(nodes: PMJson[] | undefined, c: MdContext): string {
  return (nodes ?? []).map(n => {
    if (n.type === 'text') {
      let t = esc(n.text ?? '')
      const marks = (n.marks ?? []).map(m => m.type)
      if (marks.includes('code')) t = '`' + (n.text ?? '') + '`'
      if (marks.includes('bold')) t = `**${t}**`
      if (marks.includes('italic')) t = `*${t}*`
      if (marks.includes('strike')) t = `~~${t}~~`
      if (marks.includes('underline')) t = `<u>${t}</u>`
      const link = (n.marks ?? []).find(m => m.type === 'link')
      return link ? `[${t}](${String(link.attrs?.href ?? '')})` : t
    }
    if (n.type === 'hardBreak') return '  \n'
    if (n.type === 'mathInline') return `$${attr(n, 'latex')}$`
    if (n.type === 'pageLink') return `[[${c.titleOf?.(String(attr(n, 'dstId'))) || attr(n, 'label') || ''}]]`
    return inline(n.content, c)
  }).join('')
}

const indent = (s: string, pad: string) => s.split('\n').map(l => (l ? pad + l : l)).join('\n')
const wrapDir = (n: PMJson, md: string, c: MdContext) => {
  const d = String(attr(n, 'dir') ?? 'auto')
  return d !== 'auto' && d !== (c.pageDir ?? 'auto') ? `<div dir="${d}">\n\n${md}\n\n</div>` : md
}

function block(n: PMJson, c: MdContext): string {
  switch (n.type) {
    case 'paragraph': return wrapDir(n, inline(n.content, c), c)
    case 'heading': return wrapDir(n, '#'.repeat(Math.min(3, Number(attr(n, 'level') ?? 1))) + ' ' + inline(n.content, c), c)
    case 'bulletList': return (n.content ?? []).map(li => '- ' + indent(blocks(li.content, c), '  ').trimStart()).join('\n')
    case 'orderedList': return (n.content ?? []).map((li, i) => `${i + 1}. ` + indent(blocks(li.content, c), '   ').trimStart()).join('\n')
    case 'taskList': return (n.content ?? []).map(li => `- [${attr(li, 'checked') ? 'x' : ' '}] ` + indent(blocks(li.content, c), '  ').trimStart()).join('\n')
    case 'blockquote': return blocks(n.content, c).split('\n').map(l => '> ' + l).join('\n')
    case 'callout': return [`> [!${String(attr(n, 'icon') || 'note')}]`, ...blocks(n.content, c).split('\n').map(l => '> ' + l)].join('\n')
    case 'toggle': { const [h, ...rest] = n.content ?? []; return `<details>\n<summary>${inline(h?.content, c)}</summary>\n\n${blocks(rest, c)}\n\n</details>` }
    case 'codeBlock': return '```' + String(attr(n, 'language') ?? '') + '\n' + (n.content ?? []).map(t => t.text ?? '').join('') + '\n```'
    case 'mathBlock': return `$$\n${attr(n, 'latex')}\n$$`
    case 'mermaid': return '```mermaid\n' + attr(n, 'code') + '\n```'
    case 'image': {
      const hash = String(attr(n, 'blob') ?? ''), alt = String(attr(n, 'alt') ?? '')
      const src = hash ? (c.attachment?.(hash) ?? `attachments/${hash}`) : String(attr(n, 'src') ?? '')
      return src ? `![${esc(alt)}](${src})` : ''
    }
    case 'file': { const h = String(attr(n, 'blob') ?? ''); return `[${esc(String(attr(n, 'name') ?? 'file'))}](${c.attachment?.(h, String(attr(n, 'name') ?? '')) ?? `attachments/${h}`})` }
    case 'drawing': return '<!-- drawing -->'
    case 'layoutGroup': return `<div class="nv-columns">\n\n${(n.content ?? []).map(col => `<div class="nv-column">\n\n${blocks(col.content, c)}\n\n</div>`).join('\n\n')}\n\n</div>`
    case 'table': return table(n, c)
    case 'horizontalRule': return '---'
    default: return inline(n.content, c)
  }
}
const blocks = (nodes: PMJson[] | undefined, c: MdContext): string => (nodes ?? []).map(n => block(n, c)).filter(s => s !== '').join('\n\n')

// Markdown is not parsed inside raw HTML tables by common Markdown renderers. Render their
// contents as HTML, escaping text and attributes independently of the surrounding Markdown.
const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function htmlInline(nodes: PMJson[] | undefined, c: MdContext): string {
  return (nodes ?? []).map(n => {
    if (n.type === 'text') {
      let text = htmlEscape(n.text ?? '')
      for (const mark of n.marks ?? []) {
        const tag = ({ bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code' } as Record<string, string>)[mark.type]
        if (tag) text = `<${tag}>${text}</${tag}>`
        else if (mark.type === 'link' && isSafeHref(String(mark.attrs?.href ?? ''))) text = `<a href="${htmlEscape(String(mark.attrs?.href ?? ''))}">${text}</a>`
      }
      return text
    }
    if (n.type === 'hardBreak') return '<br>'
    if (n.type === 'pageLink') {
      const id = String(attr(n, 'dstId') ?? '')
      const label = String(c.titleOf?.(id) || attr(n, 'label') || '')
      return `<span data-type="page-link" data-dst="${htmlEscape(id)}" data-label="${htmlEscape(label)}">${htmlEscape(label)}</span>`
    }
    if (n.type === 'mathInline') return `<span data-type="math-inline" data-latex="${htmlEscape(String(attr(n, 'latex') ?? ''))}"></span>`
    return htmlInline(n.content, c)
  }).join('')
}
function htmlBlocks(nodes: PMJson[] | undefined, c: MdContext): string {
  return (nodes ?? []).map(n => {
    if (n.type === 'paragraph' || n.type === 'heading') {
      const tag = n.type === 'paragraph' ? 'p' : `h${Math.max(1, Math.min(3, Number(attr(n, 'level') ?? 1)))}`
      const dir = String(attr(n, 'dir') ?? 'auto')
      return `<${tag}${dir === 'rtl' || dir === 'ltr' ? ` dir="${dir}"` : ''}>${htmlInline(n.content, c)}</${tag}>`
    }
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      const tag = n.type === 'bulletList' ? 'ul' : 'ol'
      return `<${tag}>${(n.content ?? []).map(item => `<li>${htmlBlocks(item.content, c)}</li>`).join('')}</${tag}>`
    }
    if (n.type === 'taskList') return `<ul data-type="taskList">${(n.content ?? []).map(item => `<li data-type="taskItem" data-checked="${attr(item, 'checked') ? 'true' : 'false'}">${htmlBlocks(item.content, c)}</li>`).join('')}</ul>`
    if (n.type === 'horizontalRule') return '<hr>'
    if (n.type === 'callout') return `<div data-type="callout" data-icon="${htmlEscape(String(attr(n, 'icon') ?? ''))}">${htmlBlocks(n.content, c)}</div>`
    if (n.type === 'toggle') return `<div data-type="toggle">${htmlBlocks(n.content, c)}</div>`
    if (n.type === 'mathBlock') return `<div data-type="math-block" data-latex="${htmlEscape(String(attr(n, 'latex') ?? ''))}"></div>`
    if (n.type === 'mermaid') return `<div data-type="mermaid" data-code="${htmlEscape(String(attr(n, 'code') ?? ''))}"></div>`
    if (n.type === 'table') return table(n, c, true)
    if (n.type === 'blockquote') return `<blockquote>${htmlBlocks(n.content, c)}</blockquote>`
    if (n.type === 'codeBlock') return `<pre><code>${htmlEscape((n.content ?? []).map(t => t.text ?? '').join(''))}</code></pre>`
    // Keep the existing Markdown representation for uncommon blocks the mirror already supports.
    return htmlEscape(block(n, c))
  }).join('')
}

/** A GFM table when every cell is one plain paragraph without merged cells; otherwise HTML. */
function table(n: PMJson, c: MdContext, forceHtml = false): string {
  const rows = n.content ?? []
  const simple = rows.every(r => (r.content ?? []).every(cell => Number(attr(cell, 'colspan') ?? 1) === 1 && Number(attr(cell, 'rowspan') ?? 1) === 1 && (cell.content ?? []).length === 1 && cell.content![0]!.type === 'paragraph'))
  const rawDir = String(attr(n, 'dir') ?? 'auto')
  const dir = rawDir === 'rtl' || rawDir === 'ltr' ? rawDir : 'auto'
  if (!forceHtml && simple && dir === 'auto') {
    const cells = rows.map(r => (r.content ?? []).map(cell => inline(cell.content![0]!.content, c).replace(/(?<!\\)\|/g, '\\|')))
    const head = cells[0] ?? []
    return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...cells.slice(1).map(r => `| ${r.join(' | ')} |`)].join('\n')
  }
  const span = (cell: PMJson, key: string) => {
    const value = Number(attr(cell, key) ?? 1)
    return Number.isSafeInteger(value) && value > 1 ? ` ${key}="${value}"` : ''
  }
  const tr = rows.map(r => `<tr>${(r.content ?? []).map(cell => `<${cell.type === 'tableHeader' ? 'th' : 'td'}${span(cell, 'colspan')}${span(cell, 'rowspan')}>${htmlBlocks(cell.content, c)}</${cell.type === 'tableHeader' ? 'th' : 'td'}>`).join('')}</tr>`).join('\n')
  return `<table${dir !== 'auto' ? ` dir="${dir}"` : ''}>\n${tr}\n</table>`
}

/** The page as Markdown (front matter included when `meta` is given). */
export function toMarkdown(doc: PMJson, c: MdContext = {}, meta?: { id: string; title: string; parent?: string; tags?: string[]; created?: number; updated?: number; dir?: string }): string {
  const body = blocks(doc.content, c)
  if (!meta) return body + '\n'
  const q = (s: string) => JSON.stringify(s)
  const fm = ['---', `id: ${q(meta.id)}`, `title: ${q(meta.title)}`, `parent: ${q(meta.parent ?? '')}`, `tags: [${(meta.tags ?? []).map(q).join(', ')}]`, `created: ${meta.created ?? 0}`, `updated: ${meta.updated ?? 0}`, `dir: ${meta.dir ?? 'auto'}`, '---', '<!-- این فایل خودکار ساخته می‌شود؛ تغییرات شما بازنویسی می‌شود. / This file is generated; your edits are overwritten. -->', '']
  return fm.join('\n') + '\n' + body + '\n'
}

/** The file name of a page: `<slug of the title>--<last 8 characters of the id>.md`. */
export function mdFileName(title: string, id: string): string {
  const slug = title.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
  return `${slug}--${id.slice(-8)}.md`
}
