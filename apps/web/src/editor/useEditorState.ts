import { useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'

/** Floating UI reads the existing editor; it never creates a second editor or document. */
export function useEditorState<T>({ editor, selector }: { editor: Editor; selector: (value: { editor: Editor }) => T }): T {
  useSyncExternalStore(
    changed => {
      editor.on('transaction', changed)
      editor.on('focus', changed)
      editor.on('blur', changed)
      return () => { editor.off('transaction', changed); editor.off('focus', changed); editor.off('blur', changed) }
    },
    () => editor.state,
  )
  return selector({ editor })
}
