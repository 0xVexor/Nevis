// The schema contract of ADR-0003 §5 as a function, so that every block ported from the old editor is checked mechanically:
//  - every attribute of every node and mark has a default, and the default is a string, an integer or a boolean (never null,
//    undefined, an object or an array; a non-integer number is refused too: JSON numbers round-trip, floats are a trap);
//  - every block-level node except `doc` carries `blockId`;
//  - `dir`, where present, defaults to "auto".
import type { Schema } from '@tiptap/pm/model'

export function auditSchema(schema: Schema): string[] {
  const bad: string[] = []
  const check = (what: string, attrs: Record<string, { default?: unknown }> | undefined) => {
    for (const [k, a] of Object.entries(attrs ?? {})) {
      if (!('default' in a)) { bad.push(`${what}.${k}: no default`); continue }
      const d = a.default
      const ok = typeof d === 'string' || typeof d === 'boolean' || (typeof d === 'number' && Number.isInteger(d))
      if (!ok) bad.push(`${what}.${k}: default ${JSON.stringify(d)} is not a string, integer or boolean`)
      if (k === 'dir' && d !== 'auto') bad.push(`${what}.dir: default must be "auto"`)
    }
  }
  for (const [name, t] of Object.entries(schema.nodes)) {
    check(`node ${name}`, t.spec.attrs)
    if (t.isBlock && name !== 'doc' && !t.spec.attrs?.blockId) bad.push(`node ${name}: a block without blockId`)
  }
  for (const [name, t] of Object.entries(schema.marks)) check(`mark ${name}`, t.spec.attrs)
  return bad
}
