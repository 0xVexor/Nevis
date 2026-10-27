import type { Schema } from '@tiptap/pm/model'
import { layoutStructureValid } from './layoutModel'

/** Parsing must never silently discard content written by a newer editor. */
export function contentProblem(content: unknown, schema: Schema): string | null {
  if (typeof content === 'string') return null // supported legacy HTML
  try {
    const visit = (node: any) => {
      if (!node || typeof node.type !== 'string' || !schema.nodes[node.type]) throw new Error('node')
      if (Object.keys(node).some(key => !['type', 'attrs', 'content', 'marks', 'text'].includes(key))) throw new Error('field')
      const attrs = schema.nodes[node.type].spec.attrs ?? {}
      if (Object.keys(node.attrs ?? {}).some(key => !(key in attrs))) throw new Error('attribute')
      for (const mark of node.marks ?? []) {
        if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key))) throw new Error('mark field')
        const spec = schema.marks[mark.type]?.spec
        if (!spec || Object.keys(mark.attrs ?? {}).some(key => !(key in (spec.attrs ?? {})))) throw new Error('mark')
      }
      for (const child of node.content ?? []) visit(child)
    }
    visit(content)
    const doc = schema.nodeFromJSON(content)
    if (doc.type !== schema.topNodeType) throw new Error('Expected document')
    doc.check()
    if (!layoutStructureValid(doc)) throw new Error('Unsupported layout')
    return null
  } catch {
    return 'This page uses unsupported content. Update the app to edit it. The original content has been kept.'
  }
}
