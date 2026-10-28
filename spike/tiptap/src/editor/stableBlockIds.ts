import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

// Preserve existing identities on all clients; assign identities only to Drive documents.
export let driveBlockIds = false
export const enableDriveBlockIds = (enabled: boolean) => { driveBlockIds = enabled }
export const StableBlockIds = Extension.create({
  name: 'stableBlockIds',
  addGlobalAttributes() {
    return [{ types: ['horizontalRule', 'paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'layoutGroup', 'layoutColumn', 'image', 'callout', 'toggle', 'mathBlock', 'drawing', 'mermaid', 'databaseEmbed'], attributes: {
      stableBlockId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    } }]
  },
  addProseMirrorPlugins() {
    return [new Plugin({ appendTransaction(transactions, _old, state) {
      if (!transactions.some(t => t.docChanged)) return null
      let active = driveBlockIds
      state.doc.descendants(node => { if (node.attrs.stableBlockId) active = true })
      if (!active) return null
      const seen = new Set<string>(), tr = state.tr
      state.doc.descendants((node, pos) => {
        if (!Object.hasOwn(node.attrs, 'stableBlockId')) return
        let id = node.attrs.stableBlockId as string | null
        if (!id || seen.has(id)) { id = crypto.randomUUID(); tr.setNodeMarkup(pos, undefined, { ...node.attrs, stableBlockId: id }) }
        seen.add(id)
      })
      return tr.docChanged ? tr : null
    } })]
  },
})
