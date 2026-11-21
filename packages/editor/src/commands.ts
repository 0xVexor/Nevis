// Editor commands: direction, alignment, table layout, column widths. (Inserting blocks is in insert.ts, as plain functions.) (Ported from the old editor's extensions.ts and slash.ts,
// with the attribute changes of the new schema: '' instead of null, `icon` instead of `emoji`, `dir` on the layout group.)
import { Extension, type CommandProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { DIR_TYPES } from '@nevis/schema'

const DIR_NODES: readonly string[] = DIR_TYPES

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    nevis: {
      unwrapLayout: () => ReturnType
      setColumnWidths: (widths: number[]) => ReturnType
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
    return {
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
