import { Extension } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { BLOCK_TYPES, BLOCK_IDENTITY_VERSION, isBlockId } from '../documents/blockIdentity.ts'

const key = new PluginKey('blockIdentity')
const types = new Set<string>(BLOCK_TYPES)

/** Clipboard copies get fresh IDs, including all nested table/list blocks. */
function copyFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach(node => nodes.push(node.isText ? node : node.type.create(
    types.has(node.type.name) ? { ...node.attrs, blockId: null } : node.attrs,
    copyFragment(node.content), node.marks,
  )))
  return Fragment.fromArray(nodes)
}

export function blockIdentityPlugin(createId: () => string = () => crypto.randomUUID()) {
  return new Plugin({
    key,
    props: {
      transformPasted(slice, view) {
        // ProseMirror's internal drag move must keep IDs. Its copy drop is repaired
        // against the surviving source positions by appendTransaction below.
        if (view.dragging) return slice
        return new Slice(copyFragment(slice.content), slice.openStart, slice.openEnd)
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (!transactions.some(tr => tr.docChanged || tr.getMeta('blockIdentity:init')) || state.doc.attrs.blockIdentityVersion > BLOCK_IDENTITY_VERSION) return null
      const mapping = new Mapping()
      transactions.forEach(tr => mapping.appendMapping(tr.mapping))
      const owners = new Map<string, number>()
      oldState.doc.descendants((node, pos) => {
        if (!types.has(node.type.name) || !isBlockId(node.attrs.blockId)) return
        const mapped = mapping.mapResult(pos, 1)
        if (!mapped.deleted && !owners.has(node.attrs.blockId) && state.doc.nodeAt(mapped.pos)?.attrs.blockId === node.attrs.blockId) owners.set(node.attrs.blockId, mapped.pos)
      })
      const reserved = new Set<string>()
      state.doc.descendants(node => { if (types.has(node.type.name) && isBlockId(node.attrs.blockId)) reserved.add(node.attrs.blockId) })
      const seen = new Set<string>()
      const tr = state.tr
      state.doc.descendants((node, pos) => {
        if (!types.has(node.type.name)) return
        const id = node.attrs.blockId
        if (isBlockId(id) && !seen.has(id) && (!owners.has(id) || owners.get(id) === pos)) { seen.add(id); return }
        let fresh = ''
        for (let tries = 0; tries < 100; tries++) {
          const candidate = createId()
          if (isBlockId(candidate) && !reserved.has(candidate) && !seen.has(candidate)) { fresh = candidate; break }
        }
        if (!fresh) throw new Error('Block identity allocator did not produce a fresh ID')
        seen.add(fresh)
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: fresh })
      })
      if (state.doc.attrs.blockIdentityVersion !== BLOCK_IDENTITY_VERSION) tr.setDocAttribute('blockIdentityVersion', BLOCK_IDENTITY_VERSION)
      return tr.docChanged ? tr.setMeta(key, true) : null
    },
  })
}

export const BlockIdentity = Extension.create({
  name: 'blockIdentity',
  onCreate() { this.editor.view.dispatch(this.editor.state.tr.setMeta('blockIdentity:init', true).setMeta('addToHistory', false)) },
  addGlobalAttributes() {
    return [
      { types: [...BLOCK_TYPES], attributes: { blockId: {
        default: null,
        // HTML/Markdown imports cannot import identity or take over an old target.
        parseHTML: () => null,
        renderHTML: () => ({}),
      } } },
      { types: ['doc'], attributes: { blockIdentityVersion: { default: 0, rendered: false } } },
    ]
  },
  addProseMirrorPlugins() { return [blockIdentityPlugin()] },
})
