import { getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'
import { BlockIdentity } from './blockIdentity'
import { schemaExtensions } from './extensions'

export { ALIGN_TYPES, BLOCK_TYPES, DIR_TYPES } from './extensions'
export { MAX_DRAWING_SCENE, MAX_SOURCE } from './blocks'
export { SV } from '@nevis/protocol'
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

/** The projection with every attribute that equals its schema default removed, recursively. This is what golden fixtures compare
 *  (ADR-0003 §8, docs/formats/golden-fixtures.md): a LATER schema may add attributes (with defaults) and node types without making
 *  a document written under an EARLIER one project differently, and the stored fixtures are never regenerated. */
export function dropDefaults(json: PMJson, sch: Schema = schema): PMJson {
  const out: PMJson = { type: json.type }
  const attrSpec = json.type === 'text' ? undefined : sch.nodes[json.type]?.spec.attrs
  const attrs = Object.entries(json.attrs ?? {}).filter(([k, v]) => !(attrSpec?.[k] && 'default' in attrSpec[k]! && JSON.stringify(attrSpec[k]!.default) === JSON.stringify(v)))
  if (attrs.length) out.attrs = Object.fromEntries(attrs)
  if (json.text !== undefined) out.text = json.text
  if (json.marks?.length) out.marks = json.marks.map(m => {
    const mt = sch.marks[m.type]
    const a = Object.entries(m.attrs ?? {}).filter(([k, v]) => !(mt && k in mt.spec.attrs! && JSON.stringify(mt.spec.attrs![k]!.default) === JSON.stringify(v)))
    return a.length ? { type: m.type, attrs: Object.fromEntries(a) } : { type: m.type }
  })
  if (json.content) out.content = json.content.map(c => dropDefaults(c, sch))
  return out
}
export { auditSchema } from './audit'
export { isSafeHref } from './safeHref'
