// Stable block ids (ADR-0003 §5). After EVERY transaction, local or remote, a block that has no id or repeats an earlier
// one gets a fresh UUIDv7. The first occurrence in document order keeps its id. If two devices repair the same block at
// once, Yjs' last-writer-wins on the attribute makes them agree. Pasted content never keeps ids.
import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { BLOCK_TYPES } from './extensions'
import { isBlockId, uuidv7 } from './ids'

const key = new PluginKey('nevisBlockIdentity')
const isBlock = new Set<string>(BLOCK_TYPES)

function stripIds(fragment: Fragment): Fragment {
  const out: PMNode[] = []
  fragment.forEach(node => out.push(node.isText ? node : node.type.create(isBlock.has(node.type.name) ? { ...node.attrs, blockId: '' } : node.attrs, stripIds(node.content), node.marks)))
  return Fragment.fromArray(out)
}

/** The steps that give every block without an id, or with a repeated id, a fresh one; null when nothing is wrong. */
function repair(state: EditorState, newId: () => string) {
  const seen = new Set<string>()
  const fixes: { pos: number; node: PMNode }[] = []
  state.doc.descendants((node, pos) => {
    if (!isBlock.has(node.type.name)) return
    const id = node.attrs.blockId
    if (isBlockId(id) && !seen.has(id)) seen.add(id)
    else fixes.push({ pos, node })
  })
  if (!fixes.length) return null
  const tr = state.tr
  for (const { pos, node } of fixes) {
    let id = newId()
    while (seen.has(id)) id = newId()
    seen.add(id)
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id })
  }
  return tr.setMeta('addToHistory', false)
}

const fromYjs = (tr: Transaction) => !!(tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin

export const BlockIdentity = Extension.create<{ newId: () => string }>({
  name: 'nevisBlockIdentity',
  addOptions: () => ({ newId: () => uuidv7() }),
  addProseMirrorPlugins() {
    const newId = this.options.newId
    return [
      new Plugin({
        key,
        props: { transformPasted: slice => new Slice(stripIds(slice.content), slice.openStart, slice.openEnd) },
        // A local edit is repaired in the same step. (A transaction that CAME FROM Yjs must not be repaired here: y-tiptap
        // does not write a Yjs-origin transaction back, so the fix would show in the view and never reach the document.)
        appendTransaction(transactions, _old, state) {
          if (!transactions.some(t => t.docChanged) || transactions.some(fromYjs)) return null
          const fixed = repair(state, newId)
          // y-tiptap reads the last document-changing transaction of the dispatch. An appended identity repair
          // must inherit the edit's history policy, or it suppresses undo for the entire insertion/move.
          if (fixed && transactions.some(t => t.docChanged && t.getMeta('addToHistory') !== false)) fixed.setMeta('addToHistory', true)
          return fixed
        },
        // After a remote change the repair is its own, local transaction, one microtask later, so that it is synced.
        view() {
          let scheduled = false
          return {
            update(view, prev) {
              if (scheduled || view.state.doc.eq(prev.doc)) return
              scheduled = true
              queueMicrotask(() => {
                scheduled = false
                if ((view as { isDestroyed?: boolean }).isDestroyed) return
                const tr = repair(view.state, newId)
                if (tr) view.dispatch(tr)
              })
            },
          }
        },
      }),
    ]
  },
})
