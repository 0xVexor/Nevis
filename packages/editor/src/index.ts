// One editor bound to one Y.Doc. The same factory serves the app, the demo page and the headless fuzzer.
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { BODY } from '@nevis/schema'
import type * as Y from 'yjs'
import { editorExtensions } from './extensions'
import type { EditorOptions } from './options'

export function createEditor(doc: Y.Doc, element?: HTMLElement, options: EditorOptions = {}): Editor {
  return new Editor({
    element: element ?? document.createElement('div'),
    extensions: [...editorExtensions(options), Collaboration.configure({ document: doc, field: BODY })],
  })
}

export const DIRS = ['auto', 'rtl', 'ltr'] as const
export type Dir = (typeof DIRS)[number]

/** Sets the direction of the block (paragraph, heading) or table the cursor is in. */
export function setDir(editor: Editor, dir: Dir): boolean {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d >= 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'table' || name === 'paragraph' || name === 'heading') {
      return editor.chain().command(({ tr }) => { tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, dir }); return true }).run()
    }
  }
  return false
}

export { editorExtensions } from './extensions'
export { SLASH_ITEMS } from './slash'
export { cleanPastedHtml, looksLikeMarkdown, markdownToHtml } from './paste'
export { blockDirections, firstTextDirection } from './direction'
export { isBlockedHttpUrl, safeImageSrc } from './imageUrl'
export { cleanMermaid, looksLikeMermaid } from './mermaidText'
export { readScene, writeScene } from './scene'
export type { EditorOptions, PageRef } from './options'
export { allBlocksTemplate } from './template'
