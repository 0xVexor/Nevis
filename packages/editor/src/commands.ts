// Editor commands: inserting the blocks, direction, alignment, table layout. (Ported from the old editor's extensions.ts and slash.ts,
// with the attribute changes of the new schema: '' instead of null, `icon` instead of `emoji`, `dir` on the layout group.)
import { Extension, type CommandProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { DIR_TYPES } from '@nevis/schema'
import { optionsOf } from './options'
import { S } from './strings'

const para = { type: 'paragraph' }
const DIR_NODES: readonly string[] = DIR_TYPES

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    nevis: {
      insertCallout: (icon?: string) => ReturnType
      insertToggle: () => ReturnType
      insertLayout: (count: 2 | 3) => ReturnType
      unwrapLayout: () => ReturnType
      setColumnWidths: (widths: number[]) => ReturnType
      insertMathBlock: (latex?: string) => ReturnType
      insertMathInline: (latex?: string) => ReturnType
      insertMermaid: (code?: string) => ReturnType
      insertDrawing: () => ReturnType
      insertImagePlaceholder: (alt?: string) => ReturnType
      insertPageLink: (dstId: string, label: string) => ReturnType
      setDirection: (dir: 'auto' | 'rtl' | 'ltr') => ReturnType
      setTableDirection: (dir: 'auto' | 'rtl' | 'ltr') => ReturnType
      setTableWidth: (percent: number) => ReturnType
      setTableAlign: (align: 'left' | 'center' | 'right' | '') => ReturnType
      setTextAlign: (align: 'left' | 'center' | 'right' | 'justify') => ReturnType
    }
  }
}

const ancestor = (state: CommandProps['state'], name: string) => {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type.name === name) return { node: $from.node(d), pos: d > 0 ? $from.before(d) : 0, depth: d }
  return null
}

export const NevisCommands = Extension.create({
  name: 'nevisCommands',
  addCommands() {
    // A BLOCK is never put into the middle of a text block, and never REPLACES or DELETES an empty paragraph: ProseMirror would split and re-fit
    // the surrounding structure (cells, items, callouts), and under concurrent edits that left a stored Y.Doc that every editor shows differently
    // (found by the fuzz: 8-19% of seeds when a block replaced / removed a paragraph at a random caret). So: on an EMPTY line the block goes
    // right BEFORE it (the empty line stays below the block, ready to type in); on a line with text, Enter is pressed at the end of the line first
    // and the block goes onto the new empty paragraph. Separate steps, not one transaction (measured).
    const insert = (content: Record<string, unknown>) => ({ state, chain, editor }: CommandProps) => {
      const type = state.schema.nodes[String(content.type)]
      const { $from } = state.selection
      if (!type || 'node' in state.selection || !$from.parent.isTextblock) return chain().focus().insertContent(content).run()
      if ($from.parent.content.size === 0 && $from.depth > 0) {
        const parent = $from.node($from.depth - 1), i = $from.index($from.depth - 1)
        const mustStartWithParagraph = i === 0 && ['listItem', 'taskItem', 'toggle'].includes(parent.type.name)
        if (!mustStartWithParagraph && parent.canReplaceWith(i, i, type)) return chain().focus().insertContentAt($from.before($from.depth), content).run()
      }
      chain().focus().setTextSelection($from.end()).run()
      editor.commands.splitBlock()
      return editor.chain().focus().insertContent(content).run()
    }
    // an INLINE node goes at the caret, in the text
    const insertInline = (content: Record<string, unknown>[]) => ({ chain }: CommandProps) => chain().focus().insertContent(content).run()
    return {
      insertCallout: (icon = 'bulb') => insert({ type: 'callout', attrs: { icon }, content: [para] }),
      insertToggle: () => insert({ type: 'toggle', attrs: { open: true }, content: [para, para] }),
      insertLayout: count => ({ state, editor, chain }) => {
        if (ancestor(state, 'layoutColumn')) { optionsOf(editor).notify?.(S.layoutNested); return false }
        return chain().focus().insertContent({ type: 'layoutGroup', content: Array.from({ length: count }, () => ({ type: 'layoutColumn', content: [para] })) }).run()
      },
      unwrapLayout: () => ({ state, tr, dispatch }) => {
        const g = ancestor(state, 'layoutGroup')
        if (!g) return false
        const blocks: PMNode[] = []
        g.node.forEach(col => col.forEach(b => blocks.push(b)))
        tr.replaceWith(g.pos, g.pos + g.node.nodeSize, blocks)
        dispatch?.(tr)
        return true
      },
      setColumnWidths: widths => ({ state, tr, dispatch }) => {
        const g = ancestor(state, 'layoutGroup')
        if (!g || widths.length !== g.node.childCount) return false
        let pos = g.pos + 1
        g.node.forEach((col, _o, i) => { tr.setNodeMarkup(pos, undefined, { ...col.attrs, width: Math.max(0, Math.trunc(widths[i]!)) }); pos += col.nodeSize })
        dispatch?.(tr)
        return true
      },
      insertMathBlock: (latex = '') => insert({ type: 'mathBlock', attrs: { latex } }),
      insertMathInline: (latex = '') => insertInline([{ type: 'mathInline', attrs: { latex } }]),
      insertMermaid: (code = '') => insert({ type: 'mermaid', attrs: { code } }),
      insertDrawing: () => insert({ type: 'drawing', attrs: { scene: '' } }),
      insertImagePlaceholder: (alt = '') => insert({ type: 'image', attrs: { src: '', alt } }),
      insertPageLink: (dstId, label) => ({ chain }) => chain().focus().insertContent([{ type: 'pageLink', attrs: { dstId, label } }, { type: 'text', text: ' ' }]).run(),

      setDirection: dir => ({ state, tr, dispatch }) => {
        const { from, to } = state.selection
        state.doc.nodesBetween(from, to, (node, pos) => { if (DIR_NODES.includes(node.type.name) && node.type.name !== 'table') tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir }) })
        dispatch?.(tr)
        return true
      },
      setTableDirection: dir => ({ state, tr, dispatch }) => {
        const t = ancestor(state, 'table')
        if (!t) return false
        tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, dir })
        dispatch?.(tr)
        return true
      },
      // a full-width table has nowhere to move to, so choosing a side also narrows it to 75 %
      setTableWidth: percent => ({ state, tr, dispatch }) => {
        const t = ancestor(state, 'table')
        if (!t) return false
        tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, tableWidth: percent > 0 && percent < 100 ? Math.trunc(percent) : 0 })
        dispatch?.(tr)
        return true
      },
      setTableAlign: align => ({ state, tr, dispatch }) => {
        const t = ancestor(state, 'table')
        if (!t) return false
        tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, tableAlign: align, ...(align && !t.node.attrs.tableWidth ? { tableWidth: 75 } : {}) })
        dispatch?.(tr)
        return true
      },
      // paragraphs, headings and code blocks in the selection; choosing the side that is already set clears it
      setTextAlign: align => ({ state, tr, dispatch }) => {
        const { from, to } = state.selection
        const nodes: [PMNode, number][] = []
        state.doc.nodesBetween(from, to, (node, pos) => { if (['paragraph', 'heading', 'codeBlock'].includes(node.type.name)) nodes.push([node, pos]) })
        const clear = nodes.length > 0 && nodes.every(([n]) => n.attrs.textAlign === align)
        for (const [node, pos] of nodes) tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: clear ? '' : align })
        dispatch?.(tr)
        return nodes.length > 0
      },
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-ArrowRight': () => this.editor.commands.setDirection('ltr'), 'Mod-Shift-ArrowLeft': () => this.editor.commands.setDirection('rtl') }
  },
  // Word's shortcut: left Ctrl + left Shift = LTR, right Ctrl + right Shift = RTL (fires when both keys are released with nothing in between)
  addProseMirrorPlugins() {
    return [wordShortcut(this.editor)]
  },
})

import { Plugin } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
function wordShortcut(editor: Editor) {
  let ctrl: 'L' | 'R' | null = null, shift: 'L' | 'R' | null = null, armed = false
  const side = (code: string) => (code.endsWith('Left') ? 'L' : 'R')
  const reset = () => { ctrl = shift = null; armed = false }
  return new Plugin({
    props: {
      handleDOMEvents: {
        blur: () => (reset(), false),
        keydown: (_v, e) => {
          const k = e as KeyboardEvent
          if (k.code === 'ControlLeft' || k.code === 'ControlRight') ctrl = side(k.code)
          else if (k.code === 'ShiftLeft' || k.code === 'ShiftRight') shift = side(k.code)
          else { armed = false; return false } // some other key: a different shortcut
          if (ctrl && shift && ctrl === shift) armed = true
          return false
        },
        keyup: (_v, e) => {
          const k = e as KeyboardEvent
          if (/^(Control|Shift)(Left|Right)$/.test(k.code) && armed) { armed = false; editor.commands.setDirection(ctrl === 'L' ? 'ltr' : 'rtl') }
          if (k.code.startsWith('Control')) ctrl = null
          if (k.code.startsWith('Shift')) shift = null
          if (!ctrl && !shift) armed = false
          return false
        },
      },
    },
  })
}
