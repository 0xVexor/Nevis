import { getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'
import { BlockIdentity } from './blockIdentity'
import { schemaExtensions } from './extensions'

export { BLOCK_TYPES, DIR_TYPES, SV } from './extensions'
export { isBlockId, uuidv7 } from './ids'
export { BlockIdentity } from './blockIdentity'

/** The Yjs XmlFragment that holds the page body (ADR-0003 §1). */
export const BODY = 'body'

export const extensions = [...schemaExtensions, BlockIdentity]
export const schema: Schema = getSchema(extensions)

export type PMJson = { type: string; attrs?: Record<string, unknown>; content?: PMJson[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string }

/** The page as ProseMirror JSON, defaults filled in. Convergence is always judged on this, never on bytes (ADR-0003 §8). */
export function project(doc: Y.Doc): PMJson {
  return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY), schema).toJSON() as PMJson
}

/** The JSON a node would have after a round trip through the schema (defaults filled in). */
export const normalize = (json: PMJson): PMJson => schema.nodeFromJSON(json).toJSON() as PMJson

/** Every attribute value in a document, to check the "no null" rule. */
export function* attrValues(json: PMJson, path = ''): Generator<[string, unknown]> {
  for (const [k, v] of Object.entries(json.attrs ?? {})) yield [`${path}/${json.type}.${k}`, v]
  for (const m of json.marks ?? []) for (const [k, v] of Object.entries(m.attrs ?? {})) yield [`${path}/${json.type}:${m.type}.${k}`, v]
  for (const [i, c] of (json.content ?? []).entries()) yield* attrValues(c, `${path}/${json.type}[${i}]`)
}
