// Helpers shared by command handlers.
import type { Allocator, Container, Definition, Id, Json, Kind, Principal, Source, View } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { compareKeys, keyBetween, keysBetween } from '../model/ids.ts'
import { matchKey } from '../text.ts'
import { cfgOf, rollupConfig, type OptionColor, type SelectOption, OPTION_COLORS, type StatusConfig } from '../props/config.ts'
import { compileFormula, formulaConfigOf } from '../formula/compile.ts'
import { schemaFor } from '../resolver.ts'
import type { Ctx } from './coordinator.ts'
import type { Draft } from './draft.ts'

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export const LIMITS = {
  propertiesPerSource: 500,
  rowsPerSource: 250_000,
  rowBytes: 2.5 * 1024 * 1024,
  graphMaxNodes: 500,
  graphMaxEdges: 3000,
  edgesSoftWarn: 100_000,
  relationPickerEdges: 10_000,
}

export const DEFAULT_COL_WIDTH = 200

export function source(cx: Ctx, id: Id): Source {
  const s = cx.d.get('source', id)
  if (!s || s.deletedAt !== null) fail('NOT_FOUND', 'source not found', { sourceId: id })
  return s!
}
export function container(cx: Ctx, id: Id): Container {
  const c = cx.d.get('container', id)
  if (!c || c.deletedAt !== null) fail('NOT_FOUND', 'database not found', { containerId: id })
  return c!
}
export function property(cx: Ctx, id: Id): Definition {
  const p = cx.d.get('property', id)
  if (!p || p.deletedAt !== null) fail('NOT_FOUND', 'property not found', { propertyId: id })
  return p!
}
export function view(cx: Ctx, id: Id): View {
  const v = cx.d.get('view', id)
  if (!v || v.deletedAt !== null) fail('NOT_FOUND', 'view not found', { viewId: id })
  return v!
}

export function lastKey<T extends { sortKey: string }>(list: T[]): string {
  return keyBetween(list.length ? list.map((x) => x.sortKey).sort(compareKeys)[list.length - 1] : null, null)
}

/** Duplicate names inside one source are rejected after NFC + trim + case folding; ids remain the reference. */
export function assertName(d: Draft, sourceId: Id, name: string, exceptId?: Id) {
  const n = name.normalize('NFC').trim()
  if (!n) fail('INVALID_VALUE', 'a property needs a name')
  if (n.length > 200) fail('INVALID_VALUE', 'property name is too long')
  const k = matchKey(n)
  for (const p of d.props(sourceId)) if (p.id !== exceptId && matchKey(p.name.normalize('NFC').trim()) === k) fail('INVALID_VALUE', `a property named "${name}" already exists`, { name })
}

export function bumpSchema(cx: Ctx, sourceId: Id) {
  const s = cx.d.mut('source', sourceId)
  s.schemaRevision += 1
}

export function ensureOwner(cx: Ctx): Principal {
  const have = cx.d.live('principal').find((p) => p.isLocalOwner)
  if (have) return have
  const p: Principal = { ...cx.meta(cx.env.actorId), type: 'user', displayName: 'Me', email: null, memberIds: [], isLocalOwner: true, externalId: null }
  return cx.d.add('principal', p)
}

// ───── options ─────

export type OptionInput = { id?: Id; name: string; color?: string; group?: 'todo' | 'active' | 'complete' | Id }

export function buildOptions(cx: Ctx, raw: OptionInput[] | undefined, prior: SelectOption[] = []): SelectOption[] {
  const out: SelectOption[] = [...prior]
  let prev: string | null = out.length ? out[out.length - 1].sortKey : null
  for (const o of raw ?? []) {
    if (typeof o.name !== 'string' || !o.name.trim()) fail('INVALID_VALUE', 'option needs a name')
    prev = keyBetween(prev, null)
    out.push({ id: o.id ?? cx.ids(), name: o.name, color: (OPTION_COLORS as string[]).includes(o.color ?? '') ? (o.color as OptionColor) : 'default', sortKey: prev })
  }
  return out
}

export function buildStatusConfig(cx: Ctx, raw: { options?: OptionInput[]; default?: string } | undefined): StatusConfig {
  const keys = keysBetween(null, null, 3)
  const groups = (['todo', 'active', 'complete'] as const).map((semantic, i) => ({ id: cx.ids(), semantic, label: semantic === 'todo' ? 'To-do' : semantic === 'active' ? 'In progress' : 'Complete', sortKey: keys[i] }))
  const input: OptionInput[] = raw?.options?.length
    ? raw.options
    : [{ name: 'Not started', group: 'todo' }, { name: 'In progress', color: 'blue', group: 'active' }, { name: 'Done', color: 'green', group: 'complete' }]
  const options = input.map((o) => {
    const grp = groups.find((g) => g.semantic === o.group) ?? groups.find((g) => g.id === o.group) ?? groups[0]
    return { id: o.id ?? cx.ids(), name: o.name, color: (OPTION_COLORS as string[]).includes(o.color ?? '') ? (o.color as OptionColor) : 'default', sortKey: '', statusGroupId: grp.id }
  })
  // keep options in input order with strictly increasing keys
  let prev: string | null = null
  for (const o of options) {
    o.sortKey = keyBetween(prev, null)
    prev = o.sortKey
  }
  const def = raw?.default ? options.find((o) => o.name === raw.default)?.id : undefined
  return { options, groups, defaultOptionId: def ?? options[0].id }
}

// ───── derived-property dependency graph ─────

export function derivedDeps(d: Draft, def: Definition): Id[] {
  try {
    if (def.kind === 'formula') {
      const cfg = cfgOf.formula(def)
      const c = compileFormula(cfg.source, schemaFor(d, def.sourceId))
      if (!c.ok) return []
      return [...c.deps.ownPropertyIds, ...c.deps.relatedPropertyIds]
    }
    if (def.kind === 'rollup') {
      const c = rollupConfig(def.config)
      return [c.relationPropertyId, c.targetPropertyId]
    }
  } catch {
    /* broken definition: no edges */
  }
  return []
}

/** Reject self-reference / cycles and chains deeper than 15 formula/rollup references. */
export function checkDerivedGraph(d: Draft, root: Definition) {
  const MAX = 15
  const visiting = new Set<Id>()
  const depthOf = (id: Id, depth: number): number => {
    if (visiting.has(id)) fail('CYCLE', 'a formula or rollup depends on itself', { propertyId: id })
    const def = id === root.id ? root : d.prop(id)
    if (!def || (def.kind !== 'formula' && def.kind !== 'rollup')) return depth
    if (depth + 1 > MAX) fail('FORMULA_DEPTH', `more than ${MAX} chained formula/rollup references`, { propertyId: root.id })
    visiting.add(id)
    let max = depth + 1
    for (const dep of derivedDeps(d, def)) max = Math.max(max, depthOf(dep, depth + 1))
    visiting.delete(id)
    return max
  }
  depthOf(root.id, 0)
}

export function prepareFormulaConfig(cx: Ctx, sourceId: Id, selfId: Id | null, rawSource: string): Json {
  const c = compileFormula(rawSource, schemaFor(cx.d, sourceId, selfId ?? undefined))
  if (!c.ok) fail('FORMULA_TYPE', c.diagnostics[0].message, { diagnostics: c.diagnostics as unknown as Json })
  if (c.ok) return formulaConfigOf(c)
  return null
}

// ───── unique id allocation ─────

export function allocate(cx: Ctx, def: Definition, count: number): string[] {
  const cfg = cfgOf.id(def)
  const sequential = cfg.allocationMode === 'sequential'
  const owner = sequential ? (cfg.allocatorId ?? def.id) : cx.env.deviceId
  const id = sequential ? def.id : `${def.id}.${cx.env.deviceId}`
  let rec = cx.d.get('allocator', id)
  if (!rec) {
    const a: Allocator = { ...cx.meta(id), sourceId: def.sourceId, propertyId: def.id, mode: cfg.allocationMode, allocatorId: owner, next: 1 }
    rec = cx.d.add('allocator', a)
  } else rec = cx.d.mut('allocator', id)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    if (rec.next >= Number.MAX_SAFE_INTEGER) fail('QUOTA', 'unique id counter exhausted')
    out.push(`${owner}:${rec.next++}`)
  }
  return out
}

export const jsonOf = (v: unknown): Json => v as Json
export type { Kind }
