// Render-only text direction (ported from the old editor's headingDir.ts, with its tests): a block with `dir = auto` is shown in the
// direction of its first letter, as a DECORATION: nothing is written to the page and nothing is added to the undo history.
// A manual `dir` (rtl | ltr) on the block or on a container wins.
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u

/** The direction of the first LETTER of `text` (digits, spaces and punctuation do not decide); null when there is none. */
export function firstTextDirection(text: string): 'rtl' | 'ltr' | null {
  const first = text.match(/\p{L}/u)?.[0]
  return first ? (RTL_LETTER.test(first) ? 'rtl' : 'ltr') : null
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
// Containers that draw something on their start side (a quote bar, a callout icon, a toggle arrow) carry the direction of their text too.
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'callout', 'toggle', ...LISTS])
const explicit = (dir: unknown): 'rtl' | 'ltr' | null => (dir === 'rtl' || dir === 'ltr' ? dir : null)

/** A task's hidden checkbox label and nested lists must not decide the direction of their parent. */
export function blockDirections(doc: PMNode): DecorationSet {
  const out: Decoration[] = []
  const walk = (parent: PMNode, start: number, inherited: 'rtl' | 'ltr' | null) => {
    parent.forEach((node, offset) => {
      const pos = start + offset
      const manual = explicit(node.attrs.dir) || inherited
      if (BLOCKS.has(node.type.name)) {
        const item = node.type.name === 'listItem' || node.type.name === 'taskItem'
        const firstItem = LISTS.has(node.type.name) ? node.firstChild : null
        const text = firstItem ? firstItem.firstChild?.textContent || '' : item ? node.firstChild?.textContent || '' : node.textContent
        const childManual = firstItem ? explicit(firstItem.attrs.dir) || explicit(firstItem.firstChild?.attrs.dir) : item ? explicit(node.firstChild?.attrs.dir) : null
        const dir = manual || childManual || firstTextDirection(text)
        if (dir) out.push(Decoration.node(pos, pos + node.nodeSize, { 'data-dir': dir, style: `direction: ${dir}; unicode-bidi: isolate;` }))
      }
      if (!node.isLeaf && !node.type.spec.code) walk(node, pos + 1, manual)
    })
  }
  walk(doc, 0, null)
  return DecorationSet.create(doc, out)
}

export const HeadingDir = Extension.create({
  name: 'headingDir',
  addProseMirrorPlugins: () => [new Plugin({ key: new PluginKey('headingDir'), props: { decorations: state => blockDirections(state.doc) } })],
})
