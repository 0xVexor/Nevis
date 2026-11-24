import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { normalizeFa, insertPageLink, type PageRef } from '@nevis/editor'
import { t } from '../i18n'
import { CommandPalette } from './commandPalette'
import { DragHandle } from './dragHandle'
import { LayoutColumn, LayoutGroup, LayoutSafety } from './layout'
import { menuRender } from './menu'
import { SlashCommand } from './slash'
import { CodeBlock } from './codeBlock'
import { MathAuto, MathBlock, MathInline } from './math'
import { MermaidBlock } from './mermaid'
import { Drawing, Image, Table } from './nodeViews'
import { PhysicalShortcuts } from './physicalShortcuts'
import { TableColumnResize } from './tableResize'
import { TableTrailingParagraph } from './tableTrailingParagraph'
import { MarkdownTab } from './markdownTab'

/** The app's reference UI replaces the package's minimal demo controls, on the same Yjs schema. */
export function referenceEditorExtensions(pages: () => PageRef[]) {
  const PageLinks = Extension.create({
    name: 'pageLinkSuggest',
    addProseMirrorPlugins() {
      return [Suggestion<PageRef>({
        editor: this.editor, char: '[[', pluginKey: new PluginKey('referencePageLinks'), allowSpaces: true,
        allow: ({ editor, state }) => editor.isEditable && state.selection.$from.parent.type.name !== 'codeBlock',
        items: ({ query }) => {
          const title = query.trim(), normalized = normalizeFa(title)
          const hits = pages().filter(p => normalizeFa(p.title).includes(normalized)).slice(0, 29)
          return title && !query.includes(']') && !hits.some(p => normalizeFa(p.title) === normalized) ? [...hits, { id: '', title }] : hits
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          insertPageLink(editor, props.id, props.title)
        },
        render: menuRender<PageRef>({ label: () => t('Pages'), view: p => ({ title: p.title || t('Untitled'), desc: p.id ? '' : t('Create a new page and link to it'), icon: p.id ? 'i:file' : 'i:plus' }) }),
      })]
    },
  })
  return [LayoutGroup, LayoutColumn, LayoutSafety, DragHandle, SlashCommand, PageLinks, CommandPalette, CodeBlock, MathBlock, MathInline, MathAuto, MermaidBlock, Image, Table, TableColumnResize, TableTrailingParagraph, Drawing, PhysicalShortcuts, MarkdownTab, Extension.create({ name: 'floatingBars' })]
}
