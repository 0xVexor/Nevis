// Inserting blocks. These are PLAIN FUNCTIONS, not Tiptap commands, on purpose: a block insert takes several steps (move to the end of the line,
// press Enter, insert), and each step must be dispatched from a FRESH `editor.state`. Inside a Tiptap command the transaction is the command's
// own; dispatching other transactions from there leaves it stale, and ProseMirror throws "Applying a mismatched transaction" (found by the
// fuzz: thousands of caught RangeErrors, which had hidden how many inserts did not happen at all).
//
// The rule (measured by the fuzz): a block is never put into the middle of a text block and never replaces or deletes an empty paragraph
// (ProseMirror would split and re-fit the surrounding cells / items / callouts, and under concurrent edits that left a stored Y.Doc that every
// editor shows differently). On an EMPTY line the block goes right BEFORE it (the empty line stays below, ready to type in); on a line with text
// the caret goes to the end of the line, Enter is pressed, and the block goes onto the new empty paragraph.
import type { Editor } from '@tiptap/core'
import { optionsOf } from './options'
import { S } from './strings'

const para = { type: 'paragraph' }
type Content = Record<string, unknown>

export function insertBlock(editor: Editor, content: Content): boolean {
  const type = editor.state.schema.nodes[String(content.type)]
  const { selection } = editor.state
  const $from = selection.$from
  if (!type || 'node' in selection || !$from.parent.isTextblock) return editor.chain().focus().insertContent(content).run()
  if ($from.parent.content.size === 0 && $from.depth > 0) {
    const parent = $from.node($from.depth - 1), i = $from.index($from.depth - 1)
    const mustStartWithParagraph = i === 0 && ['listItem', 'taskItem', 'toggle'].includes(parent.type.name)
    if (!mustStartWithParagraph && parent.canReplaceWith(i, i, type)) return editor.chain().focus().insertContentAt($from.before($from.depth), content).run()
  }
  editor.chain().focus().setTextSelection($from.end()).run() // each step is dispatched on its own, from the editor's CURRENT state
  editor.commands.splitBlock()
  return editor.chain().focus().insertContent(content).run()
}

/** An INLINE node goes at the caret, in the text. */
const insertInline = (editor: Editor, content: Content[]) => editor.chain().focus().insertContent(content).run()

export const insertCallout = (editor: Editor, icon = 'bulb') => insertBlock(editor, { type: 'callout', attrs: { icon }, content: [para] })
export const insertToggle = (editor: Editor) => insertBlock(editor, { type: 'toggle', attrs: { open: true }, content: [para, para] })
export function insertLayout(editor: Editor, count: 2 | 3): boolean {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type.name === 'layoutColumn') { optionsOf(editor).notify?.(S.layoutNested); return false }
  return insertBlock(editor, { type: 'layoutGroup', content: Array.from({ length: count }, () => ({ type: 'layoutColumn', content: [para] })) })
}
export const insertMathBlock = (editor: Editor, latex = '') => insertBlock(editor, { type: 'mathBlock', attrs: { latex } })
export const insertMathInline = (editor: Editor, latex = '') => insertInline(editor, [{ type: 'mathInline', attrs: { latex } }])
export const insertMermaid = (editor: Editor, code = '') => insertBlock(editor, { type: 'mermaid', attrs: { code } })
export const insertDrawing = (editor: Editor) => insertBlock(editor, { type: 'drawing', attrs: { scene: '' } })
export const insertImagePlaceholder = (editor: Editor, alt = '') => insertBlock(editor, { type: 'image', attrs: { src: '', alt } })
export const insertPageLink = (editor: Editor, dstId: string, label: string) => insertInline(editor, [{ type: 'pageLink', attrs: { dstId, label } }, { type: 'text', text: ' ' }])
/** A table is a block too: it goes through the same rule (the 3x3 table is built as content, not with `insertTable`, which fits it in place). */
export function insertTable(editor: Editor): boolean {
  const cell = (header: boolean): Content => ({ type: header ? 'tableHeader' : 'tableCell', content: [para] })
  const row = (header: boolean): Content => ({ type: 'tableRow', content: [cell(header), cell(header), cell(header)] })
  return insertBlock(editor, { type: 'table', content: [row(true), row(false), row(false)] })
}
