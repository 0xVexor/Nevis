import type { Editor, JSONContent } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'

/** Keep async insertions at their original caret, including edits that shift its position. */
export function insertionAnchor(editor: Editor) {
  let position = editor.state.selection.to
  let anchorDoc = editor.state.doc
  let valid = true
  const track = ({ transaction, appendedTransactions = [] }: { transaction: Transaction; appendedTransactions?: Transaction[] }) => {
    for (const tr of [transaction, ...appendedTransactions]) {
      if (tr.before !== anchorDoc) valid = false
      if (tr.docChanged && tr.steps.some((step) => {
        const range = step as unknown as { from?: number; to?: number }
        return range.from === 0 && range.to === tr.before.content.size
      })) valid = false
      const mapped = tr.mapping.mapResult(position, 1)
      if (mapped.deletedAcross) valid = false
      position = mapped.pos
      anchorDoc = tr.doc
    }
  }
  const isValid = () => valid && !editor.isDestroyed && editor.isEditable && editor.state.doc === anchorDoc
  const release = () => { valid = false; editor.off('transaction', track); editor.off('destroy', release) }
  editor.on('transaction', track)
  editor.on('destroy', release)
  return {
    isValid,
    insert: (content: JSONContent) => isValid() && editor.chain().focus().insertContentAt(position, content).run(),
    release,
  }
}
