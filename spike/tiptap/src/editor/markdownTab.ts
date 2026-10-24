import { Extension } from '@tiptap/core'

type Apply = (chain: any, m: RegExpMatchArray) => any

// Marker typed by hand + Tab (no space needed), same result as the live input rules.
const RULES: [RegExp, Apply][] = [
  [/^(#{1,6})$/, (c, m) => c.setNode('heading', { level: m[1].length })],
  [/^[-*+]$/, (c) => c.toggleBulletList()],
  [/^\d+[.)]$/, (c) => c.toggleOrderedList()],
  [/^>$/, (c) => c.toggleBlockquote()],
  [/^\[ ?\]$/, (c) => c.toggleTaskList()],
  [/^```(\w*)$/, (c, m) => (m[1] === 'mermaid' ? c.insertContent({ type: 'mermaid', attrs: { code: '' } }) : c.setCodeBlock(m[1] ? { language: m[1] } : {}))],
  [/^(---|___|\*\*\*)$/, (c) => c.setHorizontalRule()],
  [/^\$\$$/, (c) => c.insertContent({ type: 'mathBlock', attrs: { latex: '' } })],
]

const BLOCKED = ['listItem', 'taskItem', 'tableCell', 'tableHeader', 'codeBlock'] // Tab already means something there

export const MarkdownTab = Extension.create({
  name: 'markdownTab',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parent.type.name !== 'paragraph') return false
        for (let d = $from.depth; d > 0; d--) if (BLOCKED.includes($from.node(d).type.name)) return false
        const text = $from.parent.textContent
        if (!text || $from.parentOffset !== text.length) return false
        for (const [re, apply] of RULES) {
          const m = text.match(re)
          if (!m) continue
          const chain = editor.chain().focus().deleteRange({ from: $from.start(), to: $from.end() })
          return apply(chain, m).run()
        }
        return false
      },
    }
  },
})
