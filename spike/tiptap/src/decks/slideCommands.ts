import type { CommandItem } from '../editor/slash'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import { calloutComponent, type DeckComponent } from './model'

export const slideCommands = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Quote', 'Code block', 'Code {name}', 'Divider', 'Diagram (Mermaid)', 'Image']

function moveBlock(offset: -1 | 1): CommandItem {
  return {
    title: offset < 0 ? 'Move block up' : 'Move block down',
    desc: 'Move this block within its row or column',
    icon: 'i:list',
    keywords: 'move reorder block',
    check: true,
    run: (chain) => chain.command(({ tr, dispatch }) => {
      const { $from, $to } = tr.selection
      let depth = $from.depth
      while (depth > 0 && !['doc', 'layoutColumn', 'deckComponent'].includes($from.node(depth).type.name)) depth--
      const parent = $from.node(depth)
      const index = $from.index(depth)
      const neighbor = index + offset
      if ($to.node(depth) !== parent || $to.index(depth) !== index || index >= parent.childCount || neighbor < 0 || neighbor >= parent.childCount) return false
      const start = Math.min(index, neighbor)
      const end = start + 2
      const moved = parent.child(index)
      const adjacent = parent.child(neighbor)
      const content = Fragment.fromArray(offset < 0 ? [moved, adjacent] : [adjacent, moved])
      if (!parent.canReplace(start, end, content)) return false
      const at = $from.posAtIndex(start, depth)
      if (dispatch) {
        const cursor = $from.pos - $from.posAtIndex(index, depth)
        tr.replaceWith(at, $from.posAtIndex(end, depth), content)
        tr.setSelection(Selection.near(tr.doc.resolve(at + (offset > 0 ? adjacent.nodeSize : 0) + cursor)))
      }
      return true
    }),
  }
}

export function slideActions(editor: Editor, components: readonly DeckComponent[] = []): CommandItem[] {
  const inColumns = editor.isActive('layoutGroup')
  const inComponent = editor.isActive('deckComponent')
  const columns = [2, 3].map((count): CommandItem => ({
    title: '{n} columns',
    vars: { n: String(count) },
    desc: 'Arrange content in columns',
    icon: 'i:table',
    keywords: 'layout columns ستون چیدمان',
    check: true,
    disabled: !inColumns && !editor.can().insertLayout(count),
    run: (chain) => (inColumns ? chain.setLayoutColumns(count) : chain.insertLayout(count)),
  }))
  columns.push(moveBlock(-1), moveBlock(1))
  if (editor.isActive('codeBlock')) {
    const compact = editor.getAttributes('codeBlock').slideStyle === 'compact'
    columns.push({
      title: compact ? 'Default code style' : 'Compact code style',
      desc: 'Change the spacing of this code block',
      icon: 'i:code',
      keywords: 'code compact style spacing',
      check: true,
      run: (chain) => chain.updateAttributes('codeBlock', { slideStyle: compact ? null : 'compact' }),
    })
  }
  if (inColumns) columns.push({ title: 'Stack columns', desc: 'Put the columns in one flow', icon: 'i:list', keywords: 'stack rows ستون', check: true, run: (chain) => chain.setLayoutColumns(1) })
  if (inComponent)
    return [
      ...columns,
      {
        title: 'Switch component variant',
        desc: 'Switch between regular and compact spacing',
        icon: 'i:callout',
        keywords: 'variant compact حالت',
        check: true,
        run: (chain, active) => chain.updateAttributes('deckComponent', { variant: active.getAttributes('deckComponent').variant === 'compact' ? 'regular' : 'compact' }),
      },
    ]
  return [
    ...columns,
    ...[calloutComponent, ...components].map(({ id, name }): CommandItem => ({
      title: id === calloutComponent.id ? 'Callout' : name,
      literalTitle: id !== calloutComponent.id,
      desc: 'Insert a reusable slide component',
      icon: 'i:callout',
      keywords: 'component callout کادر جزء',
      check: true,
      run: (chain) => chain.insertContent({ type: 'deckComponent', attrs: { componentId: id }, content: [{ type: 'paragraph' }] }),
    })),
  ]
}
