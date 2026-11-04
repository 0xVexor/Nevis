import { Plugin } from '@tiptap/pm/state'
import { commandMatches } from '../shortcutCommands'
import type { ChainedCommands } from '@tiptap/core'
import { Extension } from '@tiptap/core'

type Apply = (chain: ChainedCommands, m: RegExpMatchArray) => ChainedCommands

// Marker typed by hand + Tab (no space needed), same result as the live input rules.
const RULES: [RegExp, Apply][] = [
  [/^(#{1,6})$/, (c, m) => c.setNode('heading', { level: m[1].length })],
  [/^[-*+]$/, (c) => c.toggleBulletList()],
  [/^\d+[.)]$/, (c) => c.toggleOrderedList()],
  [/^>$/, (c) => c.toggleBlockquote()],
  [/^\[ ?\]$/, (c) => c.toggleTaskList()],
  [/^```(\w*)$/, (c, m) => (m[1] === 'mermaid' ? c.insertContent({ type: 'mermaid', attrs: { code: '' } }) : c.setCodeBlock(m[1] ? { language: m[1] } : undefined))],
  [/^(---|___|\*\*\*)$/, (c) => c.setHorizontalRule()],
  [/^\$\$$/, (c) => c.insertContent({ type: 'mathBlock', attrs: { latex: '' } })],
]

const BLOCKED = ['listItem', 'taskItem', 'tableCell', 'tableHeader', 'codeBlock'] // Tab already means something there

export const MarkdownTab = Extension.create({
  name: 'markdownTab',
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({ props: {
      handleKeyDown: (_view, event) => {
        if (!editor.isEditable || !commandMatches(event, 'Turn a typed marker (#, -, 1., >, [], ```, ---) into a block')) return false
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
    } })]
  },
})
