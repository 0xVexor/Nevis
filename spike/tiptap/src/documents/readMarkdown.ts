import type { IdentityNode } from './blockIdentity.ts'

const escape = (text: string) => text.replace(/([\\`*_{}\[\]<>|~])/g, '\\$1')
const fence = (text: string, minimum: number) => '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)))
/** Null means this node cannot be represented faithfully; structured JSON remains
 * available. No singleton title resolver, file access or destination lookups. */
export function readMarkdown(node: IdentityNode): string | null {
  const attrs = node.attrs ?? {}
  const children = node.content ?? []
  const rendered = children.map(readMarkdown)
  if (rendered.some(value => value === null)) return null
  const inline = rendered.join('')
  const blocks = rendered.join('\n\n')
  const value = (name: string) => typeof attrs[name] === 'string' ? attrs[name] as string : ''
  switch (node.type) {
    case 'text': {
      let text = escape(typeof node.text === 'string' ? node.text : '')
      const marks = (node.marks ?? []) as { type: string; attrs?: Record<string, unknown> }[]
      if (marks.length > 1 && marks.some(mark => mark.type === 'code')) return null
      for (const mark of marks) {
        if (mark.type === 'code') {
          const raw = typeof node.text === 'string' ? node.text : ''
          const ticks = fence(raw, 1)
          text = `${ticks} ${raw} ${ticks}`
        } else if (mark.type === 'bold') text = `**${text}**`
        else if (mark.type === 'italic') text = `*${text}*`
        else if (mark.type === 'strike') text = `~~${text}~~`
        else return null // includes links: never fetch or synthesize target metadata
      }
      return text
    }
    case 'hardBreak': return '  \n'
    case 'paragraph': return inline
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(attrs.level) || 1)))} ${inline}`
    case 'horizontalRule': return '---'
    case 'codeBlock': {
      const raw = children.map(child => typeof child.text === 'string' ? child.text : '').join('')
      const ticks = fence(raw, 3)
      return `${ticks}${value('language').replace(/[\r\n`]/g, '')}\n${raw}\n${ticks}`
    }
    case 'blockquote': return blocks.split('\n').map(line => `> ${line}`).join('\n')
    case 'listItem': case 'taskItem': return blocks
    case 'bulletList': case 'orderedList': case 'taskList':
      return rendered.map((text, index) => {
        const prefix = node.type === 'orderedList' ? `${(Number(attrs.start) || 1) + index}. `
          : node.type === 'taskList' ? `- [${children[index].attrs?.checked ? 'x' : ' '}] ` : '- '
        return prefix + text!.replace(/\n/g, '\n' + ' '.repeat(prefix.length))
      }).join('\n')
    default: return null
  }
}
