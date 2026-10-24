import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

/** Marks headings whose text runs right-to-left (first strong letter), so the CSS can place the accent rule on the right for them. */
export const HeadingDir = Extension.create({
  name: 'headingDir',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('headingDir'),
        props: {
          decorations(state) {
            const out: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'heading') return false
              const text = node.textContent
              const firstRtl = text.search(RTL)
              const firstLtr = text.search(LTR)
              if (firstRtl >= 0 && (firstLtr < 0 || firstRtl < firstLtr)) out.push(Decoration.node(pos, pos + node.nodeSize, { 'data-dir': 'rtl' }))
              return false
            })
            return DecorationSet.create(state.doc, out)
          },
        },
      }),
    ]
  },
})
