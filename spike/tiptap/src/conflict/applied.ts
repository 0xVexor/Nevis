import type { Schema } from '@tiptap/pm/model'
import type { ConflictMarker } from './types'
import { canonical } from '../documents/conflictMerge'

/** The block ids and the id version are the editor's own bookkeeping: it may add them to a merged page that came without. */
const bare = (node: unknown): unknown => {
  if (!node || typeof node !== 'object') return node
  const { attrs, content, ...rest } = node as { attrs?: Record<string, unknown>; content?: unknown[] }
  const { blockId: _id, blockIdentityVersion: _version, ...kept } = attrs ?? {}
  return { ...rest, ...(Object.keys(kept).length ? { attrs: kept } : {}), ...(content ? { content: content.map((c) => bare(c)) } : {}) }
}

/** Whether two page contents are the same document, comparing as the editor's schema reads them (attribute defaults filled, keys in any order). */
export function sameContent(schema: Schema, a: unknown, b: unknown): boolean {
  try {
    return canonical(bare(schema.nodeFromJSON(a).toJSON())) === canonical(bare(schema.nodeFromJSON(b).toJSON()))
  } catch {
    return false
  }
}

/** The marker with the side that the page currently shows replaced by the page as it is now (later edits included). */
export function withCurrentPage(marker: ConflictMarker, current: ConflictMarker['local']['page']): ConflictMarker {
  return { ...marker, [marker.kept]: { ...marker[marker.kept], page: current } }
}
