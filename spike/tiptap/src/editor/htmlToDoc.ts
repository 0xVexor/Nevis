import { Editor } from '@tiptap/core'
import { extensions } from './extensions'

/** HTML -> ProseMirror JSON using the real schema, without mounting anything. */
export function htmlToDoc(html: string): any {
  const ed = new Editor({ extensions, content: html })
  const json = ed.getJSON()
  ed.destroy()
  return json
}
