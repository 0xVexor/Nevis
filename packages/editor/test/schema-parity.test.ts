// The app writes with the schema of `getSchema(editorExtensions())`, built from DIFFERENT extension objects than `@nevis/schema`'s (the
// lowlight code block, the nodes that have node views). The contract and the golden fixtures are checked against `@nevis/schema`, so this
// test proves the two are the same schema, and audits the one the app really uses. `getSchema` needs no DOM.
import { getSchema } from '@tiptap/core'
import { auditSchema, schema as dataSchema } from '@nevis/schema'
import { describe, expect, it } from 'vitest'
import { Collaboration } from '@tiptap/extension-collaboration'
import { editorExtensions } from '../src/extensions'

const editorSchema = getSchema([...editorExtensions(), Collaboration.configure({})])
const spec = (t: { spec: Record<string, unknown>; isInline?: boolean }) => ({
  content: t.spec.content, group: t.spec.group, inline: t.spec.inline ?? false, atom: t.spec.atom ?? false, marks: t.spec.marks,
  attrs: Object.fromEntries(Object.entries((t.spec.attrs ?? {}) as Record<string, { default?: unknown }>).map(([k, v]) => [k, v.default])),
})

describe('the editor schema is the data schema', () => {
  it('has the same nodes and marks, with the same content, group, inline/atom flags and attribute defaults', () => {
    expect(Object.keys(editorSchema.nodes).sort()).toEqual(Object.keys(dataSchema.nodes).sort())
    expect(Object.keys(editorSchema.marks).sort()).toEqual(Object.keys(dataSchema.marks).sort())
    for (const n of Object.keys(dataSchema.nodes)) expect(spec(editorSchema.nodes[n]!), `node ${n}`).toEqual(spec(dataSchema.nodes[n]!))
    for (const m of Object.keys(dataSchema.marks)) expect(spec(editorSchema.marks[m]!), `mark ${m}`).toEqual(spec(dataSchema.marks[m]!))
  })
  it('passes the audit of ADR-0003 §5 (no null/object/array/float default, blockId on every block, dir defaults to auto)', () => {
    expect(auditSchema(editorSchema)).toEqual([])
  })
  it('is not vacuous: a changed default IS a difference', () => {
    const changed = spec(dataSchema.nodes.callout!)
    changed.attrs.icon = 'other'
    expect(changed).not.toEqual(spec(editorSchema.nodes.callout!))
  })
})
