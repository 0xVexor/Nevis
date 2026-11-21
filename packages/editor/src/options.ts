// What the app gives the editor (the editor package knows nothing about stores, pages or attachments).
import { Extension, type Editor } from '@tiptap/core'

export interface PageRef { id: string; title: string }
export interface EditorOptions {
  /** the pages a link may point to (for `[[` and for showing a link's current title) */
  pages?: () => PageRef[]
  /** a page link was clicked */
  onOpenPage?: (id: string) => void
  /** a short message for the person (an image placeholder, a drawing that was too large) */
  notify?: (message: string) => void
}

export const NevisOptions = Extension.create<EditorOptions, EditorOptions>({
  name: 'nevisOptions',
  addOptions: () => ({}),
  addStorage() { return this.options },
})
export const optionsOf = (editor: Editor): EditorOptions => ((editor.storage as unknown as { nevisOptions?: EditorOptions }).nevisOptions ?? {})
