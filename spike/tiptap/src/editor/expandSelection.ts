import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

const WORD = /[\p{L}\p{N}_‌‍]/u // letters and digits of any script; ZWNJ/ZWJ keep Persian words whole
const END = /[.!?؟…]/

/** Offsets [start, end) of the sentence (in code: the line) around [a, b] in `text`. */
function sentence(text: string, a: number, b: number, code: boolean): [number, number] {
  if (code) {
    const s = text.lastIndexOf('\n', a - 1) + 1
    const e = text.indexOf('\n', b)
    return [s, e < 0 ? text.length : e]
  }
  let s = a
  while (s > 0 && text[s - 1] !== '\n' && !(END.test(text[s - 1]) && /\s/.test(text[s] ?? ' '))) s--
  while (s < a && /\s/.test(text[s])) s++
  let e = b
  if (e > a && END.test(text[e - 1])) return [s, e] // already ends at the end of a sentence
  while (e < text.length && text[e] !== '\n' && !END.test(text[e])) e++
  while (e < text.length && END.test(text[e])) e++
  return [s, e]
}

/**
 * Grows the selection one step, like an IDE's "extend selection": word, then sentence (a line in code), then the
 * paragraph, then each surrounding block (list item, cell, quote…), then the whole page.
 */
export function expandSelection(editor: Editor): boolean {
  const { state, view } = editor
  const { from, to, $from, $to } = state.selection
  const ranges: [number, number][] = []

  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const block = $from.parent
    const base = $from.start()
    const text = block.textBetween(0, block.content.size, undefined, '￼')
    const a = $from.parentOffset,
      b = $to.parentOffset
    let ws = a,
      we = b
    while (ws > 0 && WORD.test(text[ws - 1])) ws--
    while (we < text.length && WORD.test(text[we])) we++
    ranges.push([base + ws, base + we])
    const [ss, se] = sentence(text, a, b, block.type.spec.code === true)
    ranges.push([base + ss, base + se])
    ranges.push([base, base + block.content.size])
  }
  // surrounding blocks, innermost first (only those whose content holds the whole selection)
  for (let d = Math.min($from.depth, $to.depth) - ($from.sameParent($to) ? 1 : 0); d > 0; d--) {
    if ($from.node(d) !== $to.node(d)) continue
    ranges.push([$from.start(d), $from.end(d)])
  }

  // the first step that really selects more (a block's edges can land on the same text as the paragraph inside it)
  for (const [s, e] of ranges) {
    if (s > from || e < to) continue
    const sel = TextSelection.between(state.doc.resolve(s), state.doc.resolve(e))
    if (sel.from <= from && sel.to >= to && (sel.from < from || sel.to > to)) {
      view.dispatch(state.tr.setSelection(sel))
      return true
    }
  }
  return editor.commands.selectAll()
}
