import { getSchema } from '@tiptap/core'
import { DOMSerializer, Fragment, type Schema } from '@tiptap/pm/model'
import type { DocNode } from '../docNode'
import { extensions } from '../editor/extensions'

let shared: { schema: Schema; serializer: DOMSerializer } | null = null
const editor = () => (shared ??= (() => {
  const schema = getSchema(extensions)
  return { schema, serializer: DOMSerializer.fromSchema(schema) }
})())

/** The editor schema, built once; the same one validates the merged page. */
export const editorSchema = (): Schema => editor().schema

/**
 * HTML of some top-level blocks through one shared serializer (docToHtml builds a whole Editor per call, too heavy for a long page).
 * A block the schema rejects shows as its JSON, like docToHtml does. Run hydrate() on the container afterwards.
 */
export function blocksHtml(nodes: DocNode[]): string {
  const { schema, serializer } = editor()
  const box = document.createElement('div')
  for (const node of nodes) {
    try {
      box.appendChild(serializer.serializeFragment(Fragment.from(schema.nodeFromJSON(node)), { document }))
    } catch {
      const pre = document.createElement('pre')
      pre.textContent = JSON.stringify(node, null, 2)
      box.appendChild(pre)
    }
  }
  return box.innerHTML
}
