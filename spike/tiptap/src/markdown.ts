// ProseMirror JSON -> GitHub-flavoured Markdown. Pure function; images are resolved by the caller.

type Node = { type: string; attrs?: any; content?: Node[]; text?: string; marks?: { type: string; attrs?: any }[] }
type ImageResolver = (src: string) => Promise<string> | string

let titleOf: (id: string) => string = (id) => id
/** Lets the serializer print `[[Page title]]` for page links. */
export const setPageTitleResolver = (f: (id: string) => string) => (titleOf = f)

const esc = (s: string) => s.replace(/([\\`*_{}\[\]<>|~])/g, '\\$1')

async function inline(nodes: Node[] = [], img: ImageResolver): Promise<string> {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'hardBreak') out += '  \n'
    else if (n.type === 'mathInline') out += `$${n.attrs?.latex ?? ''}$`
    else if (n.type === 'pageLink') out += n.attrs?.label && n.attrs.label !== titleOf(n.attrs?.id) ? `[[${titleOf(n.attrs?.id)}|${n.attrs.label}]]` : `[[${titleOf(n.attrs?.id)}]]`
    else if (n.type === 'image') out +=`![${esc(n.attrs?.alt ?? '')}](${await img(n.attrs.src)})`
    else if (n.type === 'text') {
      const marks = n.marks?.map((m) => m.type) ?? []
      let t = marks.includes('code') ? '`' + n.text!.replace(/`/g, '\\`') + '`' : esc(n.text!)
      // Keep markers outside surrounding spaces, otherwise Markdown does not parse them.
      const [, lead, core, trail] = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!
      t = core
      if (marks.includes('strike')) t = `~~${t}~~`
      if (marks.includes('italic')) t = `*${t}*`
      if (marks.includes('bold')) t = `**${t}**`
      if (marks.includes('underline')) t = `<u>${t}</u>`
      const link = n.marks?.find((m) => m.type === 'link')
      if (link) t = `[${t}](${link.attrs.href})`
      out += lead + t + trail
    }
  }
  return out
}

async function block(n: Node, img: ImageResolver, indent = ''): Promise<string> {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      return indent + (await inline(kids, img))
    case 'heading':
      return `${'#'.repeat(n.attrs?.level ?? 1)} ${await inline(kids, img)}`
    case 'image':
      return await inline([n], img)
    case 'databaseEmbed': {
      // Markdown can carry the existing embed as HTML; retain its reference instead of omitting it.
      const id = String(n.attrs?.containerId ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<div data-type="database-embed" data-container="${id}">Database</div>`
    }
    case 'horizontalRule':
      return '---'
    case 'drawing':
      return n.attrs?.preview ? `![Drawing](${await img('att:' + n.attrs.preview)})` : ''
    case 'mermaid':
      return '```mermaid\n' + (n.attrs?.code ?? '') + '\n```'
    case 'mathBlock':
      return `$$\n${n.attrs?.latex ?? ''}\n$$`
    case 'callout': {
      const lines = (await blocks(kids, img)).split('\n')
      return lines.map((l, i) => `> ${i === 0 ? `${({ bulb: '💡', warning: '⚠️', info: 'ℹ️', check: '✅', flame: '🔥', pin: '📌', bell: '🔔' } as Record<string, string>)[n.attrs?.emoji] ?? n.attrs?.emoji ?? '💡'} ` : ''}${l}`.trimEnd()).join('\n')
    }
    case 'toggle': {
      const [head, ...rest] = kids
      const body = rest.length ? `\n\n${await blocks(rest, img)}\n\n` : '\n'
      return `<details>\n<summary>${await inline(head?.content, img)}</summary>${body}</details>`
    }
    case 'codeBlock':
      return '```' + (n.attrs?.language ?? '') + '\n' + kids.map((k) => k.text ?? '').join('') + '\n```'
    case 'blockquote':
      return (await blocks(kids, img)).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const lines: string[] = []
      let i = n.attrs?.start ?? 1
      for (const li of kids) {
        const marker = n.type === 'bulletList' ? '-' : n.type === 'orderedList' ? `${i++}.` : `- [${li.attrs?.checked ? 'x' : ' '}]`
        const [first, ...rest] = li.content ?? []
        const head = first ? await block(first, img) : ''
        lines.push(`${marker} ${head}`)
        const pad = ' '.repeat(marker.length + 1)
        for (const r of rest) {
          const text = await block(r, img)
          lines.push(...text.split('\n').map((l) => (l ? pad + l : l)))
        }
      }
      return lines.join('\n')
    }
    case 'table': {
      const rows: string[][] = []
      let hasHeader = false
      for (const tr of kids) {
        const cells: string[] = []
        for (const td of tr.content ?? []) {
          if (td.type === 'tableHeader') hasHeader = true
          const parts = await Promise.all((td.content ?? []).map((c) => block(c, img)))
          cells.push(parts.join('<br>').replace(/(?<!\\)\|/g, '\\|').replace(/\n/g, '<br>'))
        }
        rows.push(cells)
      }
      const cols = Math.max(...rows.map((r) => r.length), 1)
      const fmt = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`
      const sep = `| ${Array(cols).fill('---').join(' | ')} |`
      const [head, ...body] = rows
      return hasHeader ? [fmt(head), sep, ...body.map(fmt)].join('\n') : [fmt(Array(cols).fill('')), sep, ...rows.map(fmt)].join('\n')
    }
    default:
      return kids.length ? blocks(kids, img) : ''
  }
}

async function blocks(nodes: Node[], img: ImageResolver): Promise<string> {
  const parts: string[] = []
  for (const n of nodes) parts.push(await block(n, img))
  return parts.join('\n\n')
}

export async function toMarkdown(title: string, doc: Node, img: ImageResolver): Promise<string> {
  const body = await blocks(doc.content ?? [], img)
  return (title ? `# ${title}\n\n` : '') + body + '\n'
}
