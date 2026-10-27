import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

/** Stop document transactions synchronously, before React can update editable state. */
export const documentCommitPlugin = (isLocked: () => boolean) => new Plugin({
  filterTransaction: transaction => !transaction.docChanged || !isLocked(),
})

export const documentCommitGuard = (isLocked: () => boolean) => Extension.create({
  name: 'documentCommitGuard',
  addProseMirrorPlugins: () => [documentCommitPlugin(isLocked)],
})
