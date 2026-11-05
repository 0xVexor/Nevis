import type { CommandItem } from '../editor/slash'
import type { Editor } from '@tiptap/core'
import { calloutComponent, type DeckComponent } from './model'

export const slideCommands = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Quote', 'Code block', 'Code {name}', 'Divider']

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
