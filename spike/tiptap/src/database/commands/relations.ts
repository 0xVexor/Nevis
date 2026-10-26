// Relations (handoff §13): canonical edges are separate logical records, oriented by the owning definition. The reverse side is
// derived from the same edge, so there is never a second authoritative copy and a crash cannot leave a half-written pair.
import type { Definition, Id, Json, RelationDefinition, RelationEdge } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keyBetween } from '../model/ids.ts'
import { cfgOf } from '../props/config.ts'
import { register, type Ctx } from './coordinator.ts'
import { LIMITS, assertName, bumpSchema, lastKey, property, source } from './util.ts'
import { createProperty, setRelationCreate } from './schema.ts'

type RelationInput = {
  targetSourceId: Id
  mode?: RelationDefinition['mode']
  cardinality?: 'one' | 'many'
  inverseCardinality?: 'one' | 'many'
  inverseName?: string
  displayedPropertyIds?: Id[]
}

function createRelation(cx: Ctx, p: { sourceId: Id; name: string; kind: Definition['kind']; config?: RelationInput; beforePropertyId?: Id }): Json {
  const c = (p.config ?? {}) as RelationInput
  const src = source(cx, p.sourceId)
  const target = source(cx, c.targetSourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_schema')
  cx.access.assertSource(cx.env.actorId, target.id, 'edit_schema')
  const mode = c.mode ?? 'one_way'
  if (mode === 'self_symmetric' && target.id !== src.id) fail('INVALID_VALUE', 'a symmetric relation links a source to itself')
  const relId = cx.ids()
  const fwdId = cx.ids()
  const invId = mode === 'paired' ? cx.ids() : null
  const forward = createProperty(cx, { id: fwdId, sourceId: src.id, name: p.name, kind: 'text', beforePropertyId: p.beforePropertyId })
  const f = cx.d.mut('property', forward.id)
  f.kind = 'relation'
  f.config = { definitionId: relId, side: 'forward' }
  if (invId) {
    const invName = c.inverseName ?? `${src.name}`
    let unique = invName
    for (let i = 2; cx.d.props(target.id).some((x) => x.name.toLowerCase() === unique.toLowerCase()); i++) unique = `${invName} ${i}`
    assertName(cx.d, target.id, unique)
    const inv = createProperty(cx, { id: invId, sourceId: target.id, name: unique, kind: 'text' })
    const mi = cx.d.mut('property', inv.id)
    mi.kind = 'relation'
    mi.config = { definitionId: relId, side: 'inverse' }
  }
  const rel: RelationDefinition = {
    ...cx.meta(relId), propertyId: fwdId, sourceId: src.id, targetSourceId: target.id, mode, inversePropertyId: invId,
    cardinality: mode === 'self_symmetric' ? 'many' : (c.cardinality ?? 'many'), inverseCardinality: c.inverseCardinality ?? 'many', displayedPropertyIds: c.displayedPropertyIds ?? [],
  }
  cx.d.add('relation', rel)
  bumpSchema(cx, src.id)
  return { propertyId: fwdId, inversePropertyId: invId, definitionId: relId }
}
setRelationCreate((cx, p) => createRelation(cx, p as never))

register('relation.configure', (cx, p: { definitionId: Id } & Partial<RelationInput> & { removeInverse?: boolean }) => {
  const rel = cx.d.get('relation', p.definitionId)
  if (!rel || rel.deletedAt !== null) fail('NOT_FOUND', 'relation not found')
  cx.access.assertSource(cx.env.actorId, rel!.sourceId, 'edit_schema')
  const m = cx.d.mut('relation', rel!.id)
  if (p.cardinality && p.cardinality !== m.cardinality) {
    if (p.cardinality === 'one') {
      const over = new Map<Id, number>()
      for (const e of cx.d.live('edge')) if (e.definitionId === m.id) over.set(e.fromPageId, (over.get(e.fromPageId) ?? 0) + 1)
      const bad = [...over].filter(([, n]) => n > 1)
      if (bad.length) fail('RELATION_LIMIT', `${bad.length} item(s) already have more than one link`, { pageIds: bad.map(([id]) => id) })
    }
    m.cardinality = p.cardinality
  }
  if (p.inverseCardinality && p.inverseCardinality !== m.inverseCardinality) {
    if (p.inverseCardinality === 'one') {
      const over = new Map<Id, number>()
      for (const e of cx.d.live('edge')) if (e.definitionId === m.id) over.set(e.toPageId, (over.get(e.toPageId) ?? 0) + 1)
      const bad = [...over].filter(([, n]) => n > 1)
      if (bad.length) fail('RELATION_LIMIT', `${bad.length} item(s) already have more than one reverse link`, { pageIds: bad.map(([id]) => id) })
    }
    m.inverseCardinality = p.inverseCardinality
  }
  if (p.displayedPropertyIds) m.displayedPropertyIds = p.displayedPropertyIds
  if (p.removeInverse && m.inversePropertyId) {
    // hides only the reverse presentation; every canonical edge stays
    const inv = cx.d.get('property', m.inversePropertyId)
    if (inv && inv.deletedAt === null) cx.d.mut('property', inv.id).deletedAt = cx.now
    m.mode = 'one_way'
    m.inversePropertyId = null
  }
  if (p.mode === 'paired' && !m.inversePropertyId && m.mode === 'one_way' && m.targetSourceId) {
    const invId = cx.ids()
    const tname = cx.d.get('source', m.sourceId)?.name ?? 'Related'
    let unique = p.inverseName ?? tname
    for (let i = 2; cx.d.props(m.targetSourceId).some((x) => x.name.toLowerCase() === unique.toLowerCase()); i++) unique = `${p.inverseName ?? tname} ${i}`
    const inv = createProperty(cx, { id: invId, sourceId: m.targetSourceId, name: unique, kind: 'text' })
    const mi = cx.d.mut('property', inv.id)
    mi.kind = 'relation'
    mi.config = { definitionId: m.id, side: 'inverse' }
    m.mode = 'paired'
    m.inversePropertyId = invId
  }
  bumpSchema(cx, m.sourceId)
})

// ───── edges ─────

type EdgeArgs = { definitionId?: Id; propertyId?: Id; fromPageId: Id; toPageId: Id; replace?: boolean }

function resolve(cx: Ctx, a: EdgeArgs): { rel: RelationDefinition; from: Id; to: Id } {
  let relId = a.definitionId
  let swap = false
  if (!relId && a.propertyId) {
    const prop = property(cx, a.propertyId)
    relId = cfgOf.relation(prop).definitionId
    swap = cfgOf.relation(prop).side === 'inverse'
  }
  const rel = relId ? cx.d.get('relation', relId) : undefined
  if (!rel || rel.deletedAt !== null) return fail('NOT_FOUND', 'relation not found')
  const forwardProp = cx.d.get('property', rel.propertyId)
  if (!forwardProp || forwardProp.deletedAt !== null) return fail('SCHEMA_MISMATCH', 'the relation property was deleted')
  return swap ? { rel, from: a.toPageId, to: a.fromPageId } : { rel, from: a.fromPageId, to: a.toPageId }
}

function validEnds(cx: Ctx, rel: RelationDefinition, from: Id, to: Id) {
  const f = cx.d.row(from)
  const t = cx.d.row(to)
  if (!f || f.sourceId !== rel.sourceId) fail('SCHEMA_MISMATCH', 'the item is not in the relation source', { pageId: from })
  if (!t || t.sourceId !== rel.targetSourceId) fail('SCHEMA_MISMATCH', 'the target is not in the related source', { pageId: to })
  if (f!.page.deletedAt !== null || t!.page.deletedAt !== null) fail('NOT_FOUND', 'a trashed item cannot be linked')
  cx.access.assertRow(cx.env.actorId, f!, 'edit_rows')
  cx.access.assertRow(cx.env.actorId, t!, 'read')
}

function dependencyCycle(cx: Ctx, rel: RelationDefinition, from: Id, to: Id): boolean {
  // blocker -> blocked must stay acyclic: adding from->to is a cycle if `from` is reachable from `to`
  const seen = new Set<Id>()
  const stack = [to]
  while (stack.length) {
    const n = stack.pop()!
    if (n === from) return true
    if (seen.has(n)) continue
    seen.add(n)
    for (const e of cx.d.edgesOut(rel.id, n)) stack.push(e.toPageId)
  }
  return false
}

export function addEdge(cx: Ctx, rel: RelationDefinition, from0: Id, to0: Id, replace = false): RelationEdge | null {
  let [from, to] = [from0, to0]
  if (rel.mode === 'self_symmetric' && from > to) [from, to] = [to, from] // one logical edge per pair
  validEnds(cx, rel, from, to)
  const settings = (cx.d.get('source', rel.sourceId)?.settings ?? {}) as Record<string, Json>
  if (from === to && (settings.dependencyRelationId === rel.id || settings.parentRelationId === rel.id)) fail('CYCLE', 'a dependency cannot point at itself')
  if (settings.dependencyRelationId === rel.id && dependencyCycle(cx, rel, from, to)) fail('CYCLE', 'this dependency would create a cycle', { fromPageId: from, toPageId: to })
  const all = cx.d.all('edge').filter((e) => e.definitionId === rel.id)
  const dup = all.find((e) => e.fromPageId === from && e.toPageId === to)
  if (dup && dup.deletedAt === null) return null // idempotent
  const outgoing = all.filter((e) => e.deletedAt === null && (e.fromPageId === from || (rel.mode === 'self_symmetric' && e.toPageId === from)) && !(dup && e.id === dup.id))
  const incoming = all.filter((e) => e.deletedAt === null && e.toPageId === to && !(dup && e.id === dup.id))
  const conflicts: RelationEdge[] = []
  if (rel.mode !== 'self_symmetric' && rel.cardinality === 'one' && outgoing.length) conflicts.push(...outgoing)
  if (rel.inverseCardinality === 'one' && rel.mode !== 'self_symmetric' && incoming.length) conflicts.push(...incoming)
  if (conflicts.length) {
    if (!replace) fail('RELATION_LIMIT', 'this relation allows one link; pass replace to swap it', { existingTargets: conflicts.map((e) => e.toPageId), existingSources: conflicts.map((e) => e.fromPageId) })
    for (const c of new Set(conflicts)) cx.d.mut('edge', c.id).deletedAt = cx.now // old target listed by the caller, remove + add in one batch
  }
  if (all.filter((e) => e.deletedAt === null).length >= LIMITS.edgesSoftWarn) cx.warnings.push({ code: 'EDGE_SOFT_LIMIT', detail: `${LIMITS.edgesSoftWarn}` })
  const key = lastKey(cx.d.edgesOut(rel.id, from))
  if (dup) {
    const m = cx.d.mut('edge', dup.id) // revive the same logical edge instead of creating a duplicate
    m.deletedAt = null
    m.sortKey = key
    m.stamp = cx.stamp()
    return m
  }
  return cx.d.add('edge', { ...cx.meta(), definitionId: rel.id, fromPageId: from, toPageId: to, sortKey: key, stamp: cx.stamp() })
}

register('relation.add', (cx, a: EdgeArgs) => {
  const { rel, from, to } = resolve(cx, a)
  const e = addEdge(cx, rel, from, to, !!a.replace)
  return { edgeId: e?.id ?? null }
})

register('relation.remove', (cx, a: EdgeArgs) => {
  const { rel, from, to } = resolve(cx, a)
  const f = cx.d.row(from)
  if (f) cx.access.assertRow(cx.env.actorId, f, 'edit_rows')
  const [x, y] = rel.mode === 'self_symmetric' && from > to ? [to, from] : [from, to]
  for (const e of cx.d.live('edge')) if (e.definitionId === rel.id && e.fromPageId === x && e.toPageId === y) cx.d.mut('edge', e.id).deletedAt = cx.now
})

register('relation.replace', (cx, a: { definitionId?: Id; propertyId?: Id; fromPageId: Id; orderedTargetPageIds: Id[] }) => {
  const { rel, from } = resolve(cx, { ...a, toPageId: a.fromPageId })
  const wanted = a.orderedTargetPageIds
  if (new Set(wanted).size !== wanted.length) fail('INVALID_VALUE', 'duplicate targets')
  if (rel.cardinality === 'one' && wanted.length > 1) fail('RELATION_LIMIT', 'this relation allows one link')
  const current = cx.d.edgesOut(rel.id, from)
  for (const e of current) if (!wanted.includes(e.toPageId)) cx.d.mut('edge', e.id).deletedAt = cx.now
  let prev: string | null = null
  for (const t of wanted) {
    const have = current.find((e) => e.toPageId === t)
    prev = keyBetween(prev, null)
    if (have) cx.d.mut('edge', have.id).sortKey = prev
    else {
      const e = addEdge(cx, rel, from, t, true)
      if (e) cx.d.mut('edge', e.id).sortKey = prev
    }
  }
})
