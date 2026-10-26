import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { firstTextDirection } from '../textDirection.ts'
export { firstTextDirection } from '../textDirection.ts'

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'taskItem', ...LISTS])
const explicit = (dir: unknown): 'rtl' | 'ltr' | null => dir === 'rtl' || dir === 'ltr' ? dir : null

/** Render-only direction: it never rewrites notes or adds automatic changes to undo history.
 * A task's hidden checkbox label and nested lists must not decide its text direction. */
export function blockDirections(doc: ProseMirrorNode): DecorationSet {
  const out: Decoration[] = []
  const walk = (parent: ProseMirrorNode, start: number, inherited: 'rtl' | 'ltr' | null) => {
    parent.forEach((node, offset) => {
      const pos = start + offset
      const manual = explicit(node.attrs.dir) || inherited
      if (BLOCKS.has(node.type.name)) {
        const item = node.type.name === 'listItem' || node.type.name === 'taskItem'
        const firstItem = LISTS.has(node.type.name) ? node.firstChild : null
        const text = firstItem ? firstItem.firstChild?.textContent || '' : item ? node.firstChild?.textContent || '' : node.textContent
        const childManual = firstItem ? explicit(firstItem.attrs.dir) || explicit(firstItem.firstChild?.attrs.dir) : item ? explicit(node.firstChild?.attrs.dir) : null
        const dir = manual || childManual || firstTextDirection(text)
        if (dir) out.push(Decoration.node(pos, pos + node.nodeSize, {
          'data-dir': dir,
          style: `direction: ${dir}; unicode-bidi: isolate;`,
        }))
      }
      if (!node.isLeaf && !node.type.spec.code) walk(node, pos + 1, manual)
    })
  }
  walk(doc, 0, null)
  return DecorationSet.create(doc, out)
}

export const HeadingDir = Extension.create({
  name: 'headingDir',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('headingDir'),
      props: { decorations: state => blockDirections(state.doc) },
    })]
  },
})
