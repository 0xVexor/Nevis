// What the app gives the editor (the editor package knows nothing about stores, pages or attachments).
import { Extension, type Editor } from '@tiptap/core'
import type { AttachmentsPort } from './attachments'

export interface PageRef { id: string; title: string }
export interface EditorOptions {
  /** the pages a link may point to (for `[[` and for showing a link's current title) */
  pages?: () => PageRef[]
  /** a page link was clicked */
  onOpenPage?: (id: string) => void
  /** a short message for the person (an image placeholder, a drawing that was too large) */
  notify?: (message: string) => void
  /** images and files stored with the page (absent: the editor shows https images only and the attach commands are off) */
  attachments?: AttachmentsPort
  /** the app draws its own find bar (it listens for `nevis:find-open` on the page): the editor then keeps its small built-in one closed */
  ownFindBar?: boolean
}

export const NevisOptions = Extension.create<EditorOptions, EditorOptions>({
  name: 'nevisOptions',
  addOptions: () => ({}),
  addStorage() { return this.options },
})
export const optionsOf = (editor: Editor): EditorOptions => ((editor.storage as unknown as { nevisOptions?: EditorOptions }).nevisOptions ?? {})
