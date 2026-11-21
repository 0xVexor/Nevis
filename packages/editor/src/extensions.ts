// The editor's extension list: the schema's own extensions (so the data contract is one thing), with the behaviour added on top.
// A node of the schema with a node view here REPLACES the schema's plain version of the same name.
import type { AnyExtension } from '@tiptap/core'
import DragHandle from '@tiptap/extension-drag-handle'
import { Placeholder } from '@tiptap/extensions'
import { BlockIdentity, schemaExtensions } from '@nevis/schema'
import { Callout, LayoutColumn, LayoutGroup, Toggle } from './blocks/containers'
import { CodeBlock } from './blocks/code'
import { Drawing } from './blocks/drawing'
import { Image, PageLink } from './blocks/media'
import { MathBlock, MathInline, Mermaid } from './blocks/rendered'
import { NevisCommands } from './commands'
import { HeadingDir } from './direction'
import { FindInPage } from './find'
import { FloatingBars } from './floating'
import { NevisOptions, type EditorOptions } from './options'
import { MarkdownPaste } from './paste'
import { PageLinkSuggest, SlashMenu } from './slash'
import { S } from './strings'

const WITH_VIEWS: AnyExtension[] = [Callout, Toggle, LayoutGroup, LayoutColumn, MathBlock, MathInline, Mermaid, Drawing, Image, PageLink, CodeBlock]
const viewNames = new Set(WITH_VIEWS.map(e => e.name))

/** Every extension of the editor, without the collaboration binding (added by `createEditor`). */
export function editorExtensions(options: EditorOptions = {}): AnyExtension[] {
  const handle = () => { const el = document.createElement('div'); el.className = 'drag-handle'; el.textContent = '⠿'; el.title = 'جابه‌جایی'; return el }
  return [
    ...schemaExtensions.filter(e => !viewNames.has(e.name)),
    BlockIdentity,
    ...WITH_VIEWS,
    NevisOptions.configure(options),
    NevisCommands, HeadingDir, MarkdownPaste, SlashMenu, PageLinkSuggest, FloatingBars, FindInPage,
    Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'paragraph' ? S.slash.placeholder : ''), showOnlyCurrent: true }),
    DragHandle.configure({ render: handle }),
  ]
}
