import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const key = new PluginKey<DecorationSet>('rtlFlowArrows')
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u
const FLOW_ARROW = /[\u2192\u21D2\u27F6\u27F9]/gu

/** Logical "next step" arrows follow RTL prose without rewriting the document.
 * Code, links and Latin expressions retain their literal arrow direction. */
function decorations(doc: ProseMirrorNode): DecorationSet {
  const result: Decoration[] = []
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return
    if (block.type.spec.code || block.attrs.dir === 'ltr') return false
    let prose = ''
    block.forEach(child => {
      if (child.isText && !child.marks.some(mark => mark.type.name === 'code')) prose += child.text
    })
    const firstLetter = prose.match(/\p{L}/u)?.[0]
    if (block.attrs.dir !== 'rtl' && (!firstLetter || !RTL_LETTER.test(firstLetter))) return false
    const text = block.textBetween(0, block.content.size, '', '\uFFFC')
    block.descendants((node, offset) => {
      if (!node.isText || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return false
      for (const match of node.text!.matchAll(FLOW_ARROW)) {
        const index = offset + match.index!
        // Only whitespace-separated flow separators beside RTL words, so an
        // expression such as x -> y (or its Unicode equivalent) stays literal.
        if (!/\s/u.test(text[index - 1] ?? '') || !/\s/u.test(text[index + 1] ?? '')) continue
        const before = text.slice(0, index).trimEnd().match(/\S+$/u)?.[0] ?? ''
        const after = text.slice(index + 1).trimStart().match(/^\S+/u)?.[0] ?? ''
        if (!RTL_LETTER.test(before) && !RTL_LETTER.test(after)) continue
        const from = pos + 1 + index
        result.push(Decoration.inline(from, from + match[0].length, { class: 'rtl-flow-arrow' }))
      }
      return false
    })
    return false
  })
  return DecorationSet.create(doc, result)
}

export const FlowArrows = Extension.create({
  name: 'flowArrows',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => decorations(state.doc),
        apply: (tr, previous) => tr.docChanged ? decorations(tr.doc) : previous,
      },
      props: { decorations: state => key.getState(state) ?? DecorationSet.empty },
    })]
  },
})
