import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

/** Keep an accessible place to continue writing after a terminal table. */
export const TableTrailingParagraph = Extension.create({
  name: 'tableTrailingParagraph',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      appendTransaction(_transactions, _oldState, state) {
        if (!editor.isEditable || state.doc.lastChild?.type.name !== 'table') return null
        return state.tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create())
      },
    })]
  },
})
