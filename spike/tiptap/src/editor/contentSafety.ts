import type { Schema } from '@tiptap/pm/model'
import { layoutStructureValid } from './layoutModel'

/** Validate before parsing into an editor: a permissive parse could discard unknown nodes. */
export function contentProblem(content: unknown, schema: Schema): string | null {
  if (typeof content === 'string') return null // legacy HTML follows the existing import path
  try {
    const check = (n: any) => {
      if (!n || !schema.nodes[n.type]) throw new Error('Unknown node')
      if (n.marks?.some((m: any) => !schema.marks[m.type])) throw new Error('Unknown mark')
      for (const child of n.content ?? []) check(child)
    }
    check(content)
    const doc = schema.nodeFromJSON(content)
    if (doc.type !== schema.topNodeType) throw new Error('Expected document')
    doc.check()
    if (!layoutStructureValid(doc)) throw new Error('Unsupported layout')
    return null
  } catch {
    return 'This page contains unsupported or damaged content. Editing is disabled to protect the original data.'
  }
}
