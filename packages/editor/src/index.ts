// One editor bound to one Y.Doc. The same factory serves the demo page and the headless fuzzer.
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { BODY, extensions } from '@nevis/schema'
import type * as Y from 'yjs'

export function createEditor(doc: Y.Doc, element?: HTMLElement): Editor {
  return new Editor({
    element: element ?? document.createElement('div'),
    extensions: [...extensions, Collaboration.configure({ document: doc, field: BODY })],
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
      // a paragraph inside a table cell takes its own dir; the table dir applies when the cursor is in a cell and `table` is asked
      return editor.chain().command(({ tr }) => { tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, dir }); return true }).run()
    }
  }
  return false
}
