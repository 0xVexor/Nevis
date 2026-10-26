// Container / source / property / option / view commands (handoff §12.1).
import type { Container, Definition, Id, Json, PageLike, Source, View, ViewType } from '../model/types.ts'
import { VIEW_TYPES } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keyBetween } from '../model/ids.ts'
import { renameInFormula } from '../formula/compile.ts'
import { astFromJson } from '../formula/syntax.ts'
import { walk } from '../formula/syntax.ts'
import { validateConfig, cfgOf, selectConfig, statusConfig, rollupConfig, type SelectOption } from '../props/config.ts'
import { DESCRIPTORS } from '../props/registry.ts'
import { register, type Ctx } from './coordinator.ts'
import {
  EMPTY_DOC, LIMITS, allocate, assertName, buildOptions, buildStatusConfig, bumpSchema, checkDerivedGraph, container, derivedDeps, ensureOwner, lastKey,
  prepareFormulaConfig, property, source, view, type OptionInput,
} from './util.ts'
import { validateViewConfiguration } from './viewConfig.ts'

register('principal.ensure_owner', (cx) => {
  const p = ensureOwner(cx)
  return { principalId: p.id }
})

register('database.create', (cx, p: { hostPageId?: Id; parentPageId?: Id | null; title: string; presentation?: 'inline' | 'full' }) => {
  ensureOwner(cx)
  const title = String(p.title ?? '').trim()
  let host: PageLike | undefined
  if (p.hostPageId) {
    host = cx.d.page(p.hostPageId)
    if (!host || host.deletedAt !== null) fail('NOT_FOUND', 'host page not found', { pageId: p.hostPageId })
    if (host!.kind === 'folder') fail('INVALID_VALUE', 'a folder cannot host a database')
    if (cx.d.live('container').some((c) => c.hostPageId === p.hostPageId && (p.presentation ?? 'full') === 'full' && c.presentation === 'full')) fail('INVALID_VALUE', 'this page already is a database')
  } else {
    const sibs = cx.d.allPages().filter((x) => x.parentId === (p.parentPageId ?? null))
    host = cx.d.addPage({
      id: cx.ids(), parentId: p.parentPageId ?? null, title, favorite: false, sort: sibs.length ? Math.max(...sibs.map((s) => Number(s.sort) || 0)) + 1 : 0,
      content: EMPTY_DOC, updatedAt: cx.now, deletedAt: null,
    } as PageLike)
  }
  const c: Container = { ...cx.meta(), hostPageId: host!.id, presentation: p.presentation ?? 'full', title: title || host!.title, sourceLinks: [] }
  cx.d.add('container', c)
  if (c.presentation === 'full') cx.d.mutPage(host!.id).dbHost = c.id
  const created = makeSource(cx, c.id, title || host!.title || 'Untitled')
  c.sourceLinks.push({ sourceId: created.sourceId, sortKey: keyBetween(null, null) })
  const v = makeView(cx, c.id, created.sourceId, 'table', 'Table', null, null)
  return { containerId: c.id, hostPageId: host!.id, sourceId: created.sourceId, titlePropertyId: created.titlePropertyId, viewId: v.id }
})

function makeSource(cx: Ctx, containerId: Id, name: string) {
  const sid = cx.ids()
  const tid = cx.ids()
  const src: Source = { ...cx.meta(sid), ownerContainerId: containerId, name, schemaRevision: 1, titlePropertyId: tid, defaultTemplateId: null, layout: {}, settings: {} }
  cx.d.add('source', src)
  const title: Definition = { ...cx.meta(tid), sourceId: sid, name: 'Name', description: '', kind: 'title', sortKey: keyBetween(null, null), config: {} }
  cx.d.add('property', title)
  return { sourceId: sid, titlePropertyId: tid }
}

function defaultConfiguration(type: ViewType, titleId: Id | null): Json {
  const base: Record<string, Json> = { visibleProperties: titleId ? [titleId] : [], widths: {}, wrap: false, density: 'normal', openMode: 'side_peek' }
  if (type === 'table') return { ...base, frozenThrough: null, totals: {}, group: null, conditionalColors: [] }
  return base
}

function makeView(cx: Ctx, containerId: Id, sourceId: Id | null, type: ViewType, name: string, parentDashboardId: Id | null, config: Json | null): View {
  const siblings = cx.d.live('view').filter((v) => v.containerId === containerId && v.parentDashboardId === parentDashboardId)
  const src = sourceId ? cx.d.get('source', sourceId) : null
  const v: View = {
    ...cx.meta(), containerId, sourceId, parentDashboardId, type, name, sortKey: lastKey(siblings), filter: null, sorts: [],
    configuration: config ?? defaultConfiguration(type, src?.titlePropertyId ?? null), defaultTemplateId: null,
  }
  return cx.d.add('view', v)
}

register('source.create', (cx, p: { ownerContainerId: Id; name: string }) => {
  const c = container(cx, p.ownerContainerId)
  cx.access.assertSource(cx.env.actorId, c.sourceLinks[0]?.sourceId ?? '', 'edit_schema')
  const mc = cx.d.mut('container', c.id)
  const created = makeSource(cx, c.id, p.name || 'Untitled')
  mc.sourceLinks.push({ sourceId: created.sourceId, sortKey: lastKey(mc.sourceLinks) })
  const v = makeView(cx, c.id, created.sourceId, 'table', 'Table', null, null)
  return { sourceId: created.sourceId, titlePropertyId: created.titlePropertyId, viewId: v.id }
})

register('source.rename', (cx, p: { sourceId: Id; name: string }) => {
  cx.access.assertSource(cx.env.actorId, p.sourceId, 'edit_schema')
  source(cx, p.sourceId)
  cx.d.mut('source', p.sourceId).name = p.name
})

register('source.link', (cx, p: { containerId: Id; sourceId: Id }) => {
  source(cx, p.sourceId)
  const c = container(cx, p.containerId)
  cx.access.assertSource(cx.env.actorId, p.sourceId, 'read')
  if (c.sourceLinks.some((l) => l.sourceId === p.sourceId)) return
  const mc = cx.d.mut('container', c.id)
  mc.sourceLinks.push({ sourceId: p.sourceId, sortKey: lastKey(mc.sourceLinks) })
  makeView(cx, c.id, p.sourceId, 'table', 'Table', null, null)
})

register('source.unlink', (cx, p: { containerId: Id; sourceId: Id }) => {
  const c = container(cx, p.containerId)
  const src = source(cx, p.sourceId)
  if (src.ownerContainerId === c.id) fail('INVALID_VALUE', 'the owning database cannot unlink its own source; delete the source instead')
  const mc = cx.d.mut('container', c.id)
  mc.sourceLinks = mc.sourceLinks.filter((l) => l.sourceId !== p.sourceId)
  // views are container-local: the linked view goes away, the source and its rows are untouched
  for (const v of cx.d.live('view')) if (v.containerId === c.id && v.sourceId === p.sourceId) cx.d.mut('view', v.id).deletedAt = cx.now
})

register('source.move_owner', (cx, p: { sourceId: Id; destinationContainerId: Id; moveViewIds?: Id[] }) => {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, p.sourceId, 'manage')
  const dst = container(cx, p.destinationContainerId)
  const old = container(cx, src.ownerContainerId)
  if (old.id === dst.id) return
  cx.d.mut('source', src.id).ownerContainerId = dst.id
  const md = cx.d.mut('container', dst.id)
  if (!md.sourceLinks.some((l) => l.sourceId === src.id)) md.sourceLinks.push({ sourceId: src.id, sortKey: lastKey(md.sourceLinks) })
  // the old owner keeps showing the source as a linked source unless it was its only one
  for (const id of p.moveViewIds ?? []) {
    const v = view(cx, id)
    if (v.sourceId !== src.id) fail('INVALID_VALUE', 'only views of the moved source can move with it')
    cx.d.mut('view', id).containerId = dst.id
  }
})

/**
 * Page layout of a source's rows (handoff §18): pinned heading properties (at most 15), sections, per-property visibility.
 * The Title always stays in the heading and the content area cannot be removed. Hiding or resetting never deletes a value.
 */
export type SourceLayout = {
  heading?: Id[]
  sections?: { id: Id; title: string; propertyIds: Id[]; collapsed?: boolean }[]
  visibility?: Record<Id, 'always' | 'hide_if_empty' | 'hidden'>
  order?: Id[]
  modules?: { id: Id; title: string; viewId: Id }[]
}
export const MAX_HEADING_PROPERTIES = 15

register('source.set_layout', (cx, p: { sourceId: Id; layout: SourceLayout | null }) => {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_schema')
  const m = cx.d.mut('source', src.id)
  if (p.layout === null) { m.layout = {}; return } // reset: the layout goes away, every definition and value stays
  const L = p.layout
  const known = new Set(cx.d.props(src.id).map((x) => x.id))
  const check = (ids: Id[] | undefined, what: string) => {
    for (const id of ids ?? []) if (!known.has(id)) fail('SCHEMA_MISMATCH', `${what} refers to a property that is not in this source`, { propertyId: id })
  }
  check(L.heading, 'heading')
  check(L.order, 'order')
  for (const s of L.sections ?? []) check(s.propertyIds, 'section')
  check(Object.keys(L.visibility ?? {}), 'visibility')
  for (const [id, v] of Object.entries(L.visibility ?? {})) {
    if (!['always', 'hide_if_empty', 'hidden'].includes(v)) fail('INVALID_VALUE', `unknown visibility ${String(v)}`)
    if (id === src.titlePropertyId && v !== 'always') fail('INVALID_VALUE', 'the title cannot be hidden')
  }
  if ((L.heading ?? []).length > MAX_HEADING_PROPERTIES) fail('QUOTA', `at most ${MAX_HEADING_PROPERTIES} properties can be pinned to the heading`)
  if (L.heading && !L.heading.includes(src.titlePropertyId)) fail('INVALID_VALUE', 'the title must stay in the heading')
  for (const mod of L.modules ?? []) {
    const v = cx.d.get('view', mod.viewId)
    if (!v || v.deletedAt !== null) fail('NOT_FOUND', 'a module points at a view that does not exist', { viewId: mod.viewId })
  }
  m.layout = L as unknown as Json
})

// ───── properties ─────

type PropertyCreate = { sourceId: Id; name: string; kind: Definition['kind']; config?: any; beforePropertyId?: Id; description?: string; id?: Id }

export function createProperty(cx: Ctx, p: PropertyCreate): Definition {
  const src = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'edit_schema')
  if (p.kind === 'title') fail('INVALID_VALUE', 'a source has exactly one Title property')
  if (!DESCRIPTORS[p.kind]) fail('INVALID_VALUE', `unknown property kind ${String(p.kind)}`)
  if (cx.d.props(src.id).length >= LIMITS.propertiesPerSource) fail('QUOTA', `a source can have at most ${LIMITS.propertiesPerSource} properties`)
  assertName(cx.d, src.id, p.name)
  const id = p.id ?? cx.ids()
  const props = cx.d.props(src.id)
  let sortKey: string
  if (p.beforePropertyId) {
    const i = props.findIndex((x) => x.id === p.beforePropertyId)
    if (i < 0) fail('NOT_FOUND', 'beforePropertyId not found')
    sortKey = keyBetween(i > 0 ? props[i - 1].sortKey : null, props[i].sortKey)
  } else sortKey = lastKey(props)
  let config: Json
  const raw = p.config ?? {}
  switch (p.kind) {
    case 'select':
    case 'multi_select': config = { options: buildOptions(cx, raw.options as OptionInput[] | undefined) } as unknown as Json; break
    case 'status': config = buildStatusConfig(cx, raw) as unknown as Json; break
    case 'formula': config = prepareFormulaConfig(cx, src.id, id, String(raw.source ?? '')); break
    case 'relation': fail('INVALID_COMMAND', 'create relations with relation.configure'); config = {}; break
    default: config = validateConfig(p.kind, raw, cx.ids)
  }
  const def: Definition = { ...cx.meta(id), sourceId: src.id, name: p.name.normalize('NFC').trim(), description: p.description ?? '', kind: p.kind, sortKey, config }
  cx.d.add('property', def)
  // a new property shows up in every view of its source that lists its properties explicitly
  for (const v of cx.d.live('view')) {
    const vis = (v.configuration as Record<string, Json>)?.visibleProperties
    if (v.sourceId === src.id && Array.isArray(vis)) cx.d.mut('view', v.id).configuration = { ...(v.configuration as Record<string, Json>), visibleProperties: [...vis, id] } as Json
  }
  if (p.kind === 'rollup') {
    const rc = rollupConfig(def.config)
    const rel = cx.d.prop(rc.relationPropertyId)
    if (!rel || rel.kind !== 'relation' || rel.sourceId !== src.id) fail('SCHEMA_MISMATCH', 'rollup needs a relation property of this source')
    const r = cx.d.relationOf(rel!.id)!
    const targetSource = r.propertyId === rel!.id ? r.targetSourceId : r.sourceId
    const t = cx.d.prop(rc.targetPropertyId)
    if (!t || t.sourceId !== targetSource) fail('SCHEMA_MISMATCH', 'rollup target property must belong to the related source')
    if (t!.kind === 'rollup') fail('SCHEMA_MISMATCH', 'a rollup cannot read another rollup directly; use a formula')
  }
  if (p.kind === 'formula' || p.kind === 'rollup') checkDerivedGraph(cx.d, def)
  if (p.kind === 'unique_id') backfillUniqueId(cx, def)
  bumpSchema(cx, src.id)
  return def
}

/** Existing rows get tokens ordered by createdAt, then Page id (§27). */
function backfillUniqueId(cx: Ctx, def: Definition) {
  const rows = cx.d.rowsOf(def.sourceId).sort((a, b) => (a.page.recordMeta?.createdAt ?? a.page.updatedAt) - (b.page.recordMeta?.createdAt ?? b.page.updatedAt) || (a.page.id < b.page.id ? -1 : 1))
  if (!rows.length) return
  const tokens = allocate(cx, def, rows.length)
  rows.forEach((r, i) => (cx.d.mutPage(r.page.id).database!.allocatedIds[def.id] = tokens[i]))
}

register('property.create', (cx, p: PropertyCreate) => {
  if (p.kind === 'relation') return relationCreate(cx, p)
  const def = createProperty(cx, p)
  return { propertyId: def.id }
})

// relation creation lives next to the relation commands; kept as a late-bound hook to avoid a cycle
let relationCreate: (cx: Ctx, p: PropertyCreate) => Json = () => fail('INVALID_COMMAND', 'relations are not available')
export const setRelationCreate = (f: typeof relationCreate) => void (relationCreate = f)

register('property.configure', (cx, p: { propertyId: Id; name?: string; description?: string; configPatch?: Record<string, Json> }) => {
  const def = property(cx, p.propertyId)
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  const m = cx.d.mut('property', def.id)
  if (p.name !== undefined && p.name !== def.name) {
    if (def.kind === 'title' && !p.name.trim()) fail('INVALID_VALUE', 'title needs a name')
    assertName(cx.d, def.sourceId, p.name, def.id)
    m.name = p.name.normalize('NFC').trim()
    renameInFormulas(cx, def.id, m.name)
  }
  if (p.description !== undefined) m.description = p.description
  if (p.configPatch) {
    for (const k of ['options', 'groups', 'defaultOptionId']) if (k in p.configPatch) fail('INVALID_COMMAND', 'change options with option.upsert / option.delete')
    if (['relation'].includes(def.kind)) fail('INVALID_COMMAND', 'change relations with relation.configure')
    const merged = { ...(m.config as Record<string, Json>), ...p.configPatch }
    if (def.kind === 'formula') {
      const src = String((p.configPatch as { source?: string }).source ?? cfgOf.formula(def).source)
      m.config = prepareFormulaConfig(cx, def.sourceId, def.id, src)
      checkDerivedGraph(cx.d, m)
    } else {
      m.config = validateConfig(def.kind, merged, cx.ids)
      if (def.kind === 'rollup') checkDerivedGraph(cx.d, m)
    }
  }
  bumpSchema(cx, def.sourceId)
})

/** A rename keeps every binding (ids); only the visible source text of formulas that mention the property is rewritten. */
function renameInFormulas(cx: Ctx, propertyId: Id, name: string) {
  for (const f of cx.d.live('property')) {
    if (f.kind !== 'formula') continue
    const cfg = cfgOf.formula(f)
    if (!cfg.ast) continue
    let uses = false
    walk(astFromJson(cfg.ast), (n) => { if (n.t === 'prop' && n.id === propertyId) uses = true })
    if (!uses) continue
    const r = renameInFormula(cfg.source, astFromJson(cfg.ast), propertyId, name)
    const mf = cx.d.mut('property', f.id)
    const refs = Object.fromEntries(Object.entries(cfg.resolvedRefs).filter(([, id]) => id !== propertyId))
    if (f.sourceId === cx.d.get('property', propertyId)?.sourceId) refs[name] = propertyId
    mf.config = { ...(mf.config as Record<string, Json>), source: r.source, ast: JSON.parse(JSON.stringify(r.ast)), resolvedRefs: refs }
  }
}

register('property.reorder', (cx, p: { sourceId: Id; orderedPropertyIds: Id[] }) => {
  cx.access.assertSource(cx.env.actorId, p.sourceId, 'edit_schema')
  const props = cx.d.props(p.sourceId)
  const want = [...p.orderedPropertyIds]
  if (want.length !== props.length || new Set(want).size !== want.length || props.some((x) => !want.includes(x.id))) fail('INVALID_VALUE', 'orderedPropertyIds must be a permutation of the active properties')
  let prev: string | null = null
  for (const id of want) {
    prev = keyBetween(prev, null)
    cx.d.mut('property', id).sortKey = prev
  }
})

register('property.delete', (cx, p: { propertyId: Id; relationPolicy?: 'presentation_only' | 'remove_relation' }) => {
  const def = property(cx, p.propertyId)
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  if (def.kind === 'title') fail('INVALID_VALUE', 'the Title property cannot be deleted')
  cx.d.mut('property', def.id).deletedAt = cx.now // the id stays tombstoned; cells stay in the rows so restoring brings values back
  if (def.kind === 'relation') {
    const rel = cx.d.relationOf(def.id)
    if (rel) {
      const isInverse = rel.inversePropertyId === def.id
      if (!isInverse || p.relationPolicy === 'remove_relation') {
        cx.d.mut('relation', rel.id).deletedAt = cx.now
        if (rel.inversePropertyId && !isInverse) {
          // removing the forward field of a paired relation removes the relation; the inverse field would dangle
          const inv = cx.d.get('property', rel.inversePropertyId)
          if (inv && inv.deletedAt === null) cx.d.mut('property', inv.id).deletedAt = cx.now
        }
      } // else only the reverse presentation is hidden; the canonical edges stay
    }
  }
  // dependents are kept with broken references; report them
  for (const dep of cx.d.live('property')) if (derivedDeps(cx.d, dep).includes(def.id)) cx.warnings.push({ code: 'BROKEN_REFERENCE', detail: `${dep.name} depends on ${def.name}` })
  for (const v of cx.d.live('view')) if (v.sourceId === def.sourceId && JSON.stringify([v.filter, v.sorts, v.configuration]).includes(def.id)) cx.warnings.push({ code: 'VIEW_REFERENCE', detail: `view ${v.name} references ${def.name}` })
  bumpSchema(cx, def.sourceId)
})

register('property.restore', (cx, p: { propertyId: Id; name?: string }) => {
  const def = cx.d.get('property', p.propertyId)
  if (!def || def.deletedAt === null) fail('NOT_FOUND', 'no deleted property with that id')
  cx.access.assertSource(cx.env.actorId, def!.sourceId, 'edit_schema')
  const name = p.name ?? def!.name
  assertName(cx.d, def!.sourceId, name) // a name taken in the meantime blocks the restore until a new one is chosen
  const m = cx.d.mut('property', def!.id)
  m.deletedAt = null
  m.name = name
  if (def!.kind === 'relation') {
    const rel = cx.d.all('relation').find((r) => r.propertyId === def!.id || r.inversePropertyId === def!.id)
    if (rel && rel.deletedAt !== null) {
      cx.d.mut('relation', rel.id).deletedAt = null
      for (const pid of [rel.propertyId, rel.inversePropertyId]) if (pid && pid !== def!.id) { const o = cx.d.get('property', pid); if (o && o.deletedAt !== null) cx.d.mut('property', pid).deletedAt = null }
    }
  }
  if (def!.kind === 'formula' || def!.kind === 'rollup') checkDerivedGraph(cx.d, m)
  bumpSchema(cx, def!.sourceId)
})

// ───── options ─────

function optionHost(cx: Ctx, propertyId: Id) {
  const def = property(cx, propertyId)
  if (!['select', 'multi_select', 'status'].includes(def.kind)) fail('INVALID_VALUE', 'this property has no options')
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  return def
}

register('option.upsert', (cx, p: { propertyId: Id; optionId?: Id; name: string; color?: string; statusGroupId?: Id; beforeOptionId?: Id }) => {
  const def = optionHost(cx, p.propertyId)
  const m = cx.d.mut('property', def.id)
  const cfg = m.config as unknown as { options: (SelectOption & { statusGroupId?: Id })[]; groups?: { id: Id; semantic: string }[]; defaultOptionId?: Id; archivedOptions?: SelectOption[] }
  const key = (s: string) => s.normalize('NFC').trim().toLowerCase()
  if (!p.name.trim()) fail('INVALID_VALUE', 'option needs a name')
  if (cfg.options.some((o) => o.id !== p.optionId && key(o.name) === key(p.name))) fail('INVALID_VALUE', `option "${p.name}" already exists`)
  const color = (['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as string[]).includes(p.color ?? '') ? p.color! : undefined
  const existing = p.optionId ? cfg.options.find((x) => x.id === p.optionId) : undefined
  if (existing) {
    const o = existing
    o.name = p.name
    if (color) o!.color = color as never
    if (def.kind === 'status' && p.statusGroupId) {
      if (!cfg.groups!.some((g) => g.id === p.statusGroupId)) fail('INVALID_VALUE', 'unknown status group')
      o!.statusGroupId = p.statusGroupId
    }
  } else {
    const id = p.optionId ?? cx.ids() // the caller may pre-assign the id so a following command in the same batch can use it
    const sorted = [...cfg.options].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
    let sortKey: string
    if (p.beforeOptionId) {
      const i = sorted.findIndex((o) => o.id === p.beforeOptionId)
      sortKey = keyBetween(i > 0 ? sorted[i - 1].sortKey : null, i >= 0 ? sorted[i].sortKey : null)
    } else sortKey = lastKey(sorted)
    const opt: SelectOption & { statusGroupId?: Id } = { id, name: p.name, color: (color ?? 'default') as never, sortKey }
    if (def.kind === 'status') {
      if (!p.statusGroupId || !cfg.groups!.some((g) => g.id === p.statusGroupId)) fail('INVALID_VALUE', 'a new status option needs a semantic group')
      opt.statusGroupId = p.statusGroupId
    }
    cfg.options.push(opt)
  }
  m.config = (def.kind === 'status' ? statusConfig(m.config) : selectConfig(m.config)) as unknown as Json
  bumpSchema(cx, def.sourceId)
})

register('option.delete', (cx, p: { propertyId: Id; optionId: Id; replacementOptionId?: Id }) => {
  const def = optionHost(cx, p.propertyId)
  const cfg = (def.kind === 'status' ? statusConfig(def.config) : selectConfig(def.config)) as { options: (SelectOption & { statusGroupId?: Id })[]; defaultOptionId?: Id }
  const opt = cfg.options.find((o) => o.id === p.optionId)
  if (!opt) fail('NOT_FOUND', 'option not found')
  if (cfg.options.length === 1 && def.kind === 'status') fail('INVALID_VALUE', 'status needs at least one option')
  const rows = cx.d.rowsOf(def.sourceId)
  const used = rows.filter((r) => { const c = r.ext.cells[def.id]?.value; return c && ((c.kind === 'status' || c.kind === 'select') ? (c.kind === 'select' ? c.optionId : c.optionId) === p.optionId : c.kind === 'multi_select' && c.optionIds.includes(p.optionId)) })
  if (def.kind === 'status' && (cfg.defaultOptionId === p.optionId || used.length) && !p.replacementOptionId) fail('INVALID_VALUE', 'choose a replacement status option first')
  if (p.replacementOptionId && (p.replacementOptionId === p.optionId || !cfg.options.some((o) => o.id === p.replacementOptionId))) fail('INVALID_VALUE', 'invalid replacement option')
  const m = cx.d.mut('property', def.id)
  const mc = m.config as unknown as { options: SelectOption[]; defaultOptionId?: Id; archivedOptions?: SelectOption[] }
  mc.archivedOptions = [...(mc.archivedOptions ?? []), opt!] // history keeps the deleted option
  mc.options = mc.options.filter((o) => o.id !== p.optionId)
  if (def.kind === 'status' && mc.defaultOptionId === p.optionId) mc.defaultOptionId = p.replacementOptionId
  for (const r of used) {
    const page = cx.d.mutPage(r.page.id)
    const cell = page.database!.cells[def.id]
    if (cell.value.kind === 'select') cell.value = { kind: 'select', optionId: null }
    else if (cell.value.kind === 'multi_select') cell.value = { kind: 'multi_select', optionIds: cell.value.optionIds.filter((x) => x !== p.optionId) }
    else if (cell.value.kind === 'status') cell.value = { kind: 'status', optionId: p.replacementOptionId! }
    cell.stamp = cx.stamp()
  }
  bumpSchema(cx, def.sourceId)
  if (used.length) cx.warnings.push({ code: 'CELLS_CLEARED', detail: String(used.length) })
})

// ───── views ─────

type ViewCreate = { containerId: Id; sourceId?: Id | null; type: ViewType; name: string; configuration?: Json; parentDashboardId?: Id | null }

register('view.create', (cx, p: ViewCreate) => {
  const c = container(cx, p.containerId)
  if (!VIEW_TYPES.includes(p.type)) fail('INVALID_VALUE', `unknown view type ${String(p.type)}`)
  if (p.type !== 'dashboard' && !p.sourceId) fail('INVALID_VALUE', 'a view needs a source')
  if (p.sourceId && !c.sourceLinks.some((l) => l.sourceId === p.sourceId)) fail('SCHEMA_MISMATCH', 'the source is not part of this database')
  if (p.sourceId) cx.access.assertSource(cx.env.actorId, p.sourceId, 'edit_schema')
  if (p.parentDashboardId) {
    const dash = view(cx, p.parentDashboardId)
    if (dash.type !== 'dashboard') fail('INVALID_VALUE', 'only a dashboard can own widgets')
    if (p.type === 'dashboard') fail('INVALID_VALUE', 'dashboards cannot be nested')
  }
  const cfg = p.configuration ?? null
  if (cfg) validateViewConfiguration(cx.d, p.type, p.sourceId ?? null, cfg)
  const v = makeView(cx, c.id, p.sourceId ?? null, p.type, p.name, p.parentDashboardId ?? null, cfg)
  if (p.sourceId && !cfg) autoConfigure(cx, v)
  return { viewId: v.id }
})

/** Board / calendar / timeline / map need a property to work from: pick an existing one or add it (shown in the create UI). */
function autoConfigure(cx: Ctx, v: View) {
  const src = v.sourceId!
  const props = cx.d.props(src)
  const first = (kinds: string[]) => props.find((x) => kinds.includes(x.kind))
  const cfg = v.configuration as Record<string, Json>
  const ensure = (kinds: string[], make: () => Definition) => first(kinds) ?? make()
  const visible = props.filter((x) => x.kind !== 'button').map((x) => x.id)
  cfg.visibleProperties = visible
  if (v.type === 'board') {
    const g = ensure(['status', 'select'], () => createProperty(cx, { sourceId: src, name: 'Status', kind: 'status' }))
    cfg.groupPropertyId = g.id
  } else if (v.type === 'calendar') {
    cfg.datePropertyId = ensure(['date'], () => createProperty(cx, { sourceId: src, name: 'Date', kind: 'date' })).id
  } else if (v.type === 'timeline') {
    cfg.datePropertyId = ensure(['date'], () => createProperty(cx, { sourceId: src, name: 'Date', kind: 'date' })).id
  } else if (v.type === 'map') {
    cfg.placePropertyId = ensure(['place'], () => createProperty(cx, { sourceId: src, name: 'Place', kind: 'place' })).id
  } else if (v.type === 'chart') {
    const c = first(['status', 'select', 'multi_select', 'date', 'checkbox', 'people'])
    if (c) cfg.chart = { type: 'bar_vertical', categoryPropertyId: c.id, measure: { kind: 'count' } } as unknown as Json
  }
  // Creating a required property replaces this view's configuration to add it to visibleProperties.
  // Commit the chosen layout keys onto that current configuration, rather than the stale object above.
  v.configuration = { ...(v.configuration as Record<string, Json>), ...cfg, visibleProperties: cx.d.props(src).filter((p) => p.kind !== 'button').map((p) => p.id) }
}

register('view.patch', (cx, p: { viewId: Id; name?: string; filter?: any; sorts?: any; configurationPatch?: Record<string, Json>; defaultTemplateId?: Id | null }) => {
  const v = view(cx, p.viewId)
  if (v.sourceId) cx.access.assertSource(cx.env.actorId, v.sourceId, 'edit_schema')
  const m = cx.d.mut('view', v.id)
  if (p.name !== undefined) m.name = p.name
  if (p.filter !== undefined) m.filter = p.filter
  if (p.sorts !== undefined) m.sorts = p.sorts
  if (p.defaultTemplateId !== undefined) m.defaultTemplateId = p.defaultTemplateId
  if (p.configurationPatch) {
    m.configuration = { ...(m.configuration as Record<string, Json>), ...p.configurationPatch }
    validateViewConfiguration(cx.d, v.type, v.sourceId, m.configuration)
  }
})

/**
 * Switch a view's layout. Settings that make sense for both layouts stay; the ones the new layout does not use are archived on
 * the view (`archived[oldType]`) and come back when the user switches back — nothing is forced onto another layout.
 */
const SHARED_KEYS = ['visibleProperties', 'widths', 'wrap', 'density', 'openMode', 'cardProperties']
register('view.set_type', (cx, p: { viewId: Id; type: ViewType }) => {
  const v = view(cx, p.viewId)
  if (!VIEW_TYPES.includes(p.type)) fail('INVALID_VALUE', `unknown view type ${String(p.type)}`)
  if (v.type === p.type) return
  if (v.sourceId) cx.access.assertSource(cx.env.actorId, v.sourceId, 'edit_schema')
  if (v.parentDashboardId === null && (p.type === 'dashboard') !== (v.type === 'dashboard')) fail('INVALID_VALUE', 'a dashboard cannot be turned into another layout (or the other way round)')
  const m = cx.d.mut('view', v.id)
  const cfg = { ...(m.configuration as Record<string, Json>) }
  const archived = { ...((cfg.archived as Record<string, Json>) ?? {}) }
  const keep: Record<string, Json> = {}
  const leave: Record<string, Json> = {}
  for (const [k, val] of Object.entries(cfg)) {
    if (k === 'archived') continue
    ;(SHARED_KEYS.includes(k) ? keep : leave)[k] = val
  }
  archived[v.type] = leave as Json
  const back = (archived[p.type] as Record<string, Json> | undefined) ?? {}
  delete archived[p.type]
  m.type = p.type
  m.configuration = { ...keep, ...back, archived } as Json
  if (m.sourceId && !Object.keys(back).length) autoConfigure(cx, m)
  validateViewConfiguration(cx.d, p.type, m.sourceId, m.configuration)
})

register('view.delete', (cx, p: { viewId: Id }) => {
  const v = view(cx, p.viewId)
  if (v.sourceId) cx.access.assertSource(cx.env.actorId, v.sourceId, 'edit_schema')
  const widgets = v.parentDashboardId !== null
  if (!widgets) {
    const left = cx.d.live('view').filter((x) => x.containerId === v.containerId && x.parentDashboardId === null && x.id !== v.id)
    if (!left.length) fail('INVALID_VALUE', 'the last view of a database cannot be deleted')
  }
  cx.d.mut('view', v.id).deletedAt = cx.now
  for (const w of cx.d.live('view')) if (w.parentDashboardId === v.id) cx.d.mut('view', w.id).deletedAt = cx.now // widgets die with their dashboard; sources and rows never do
})

register('view.duplicate', (cx, p: { viewId: Id; name?: string }) => {
  const v = view(cx, p.viewId)
  const siblings = cx.d.live('view').filter((x) => x.containerId === v.containerId && x.parentDashboardId === v.parentDashboardId)
  const copy: View = { ...structuredClone(v), ...cx.meta(), sortKey: lastKey(siblings), name: p.name ?? `${v.name} copy` }
  cx.d.add('view', copy)
  return { viewId: copy.id }
})

register('view.reorder', (cx, p: { containerId: Id; orderedViewIds: Id[] }) => {
  let prev: string | null = null
  for (const id of p.orderedViewIds) {
    prev = keyBetween(prev, null)
    view(cx, id)
    cx.d.mut('view', id).sortKey = prev
  }
})

register('view.override', (cx, p: { viewId: Id; principalId: Id; personalFilter?: any; personalSorts?: any; displayState?: Json }) => {
  // personal overrides live in a per-principal record so the shared saved configuration is untouched
  const v = view(cx, p.viewId)
  if (p.principalId !== cx.env.actorId) cx.access.assertSource(cx.env.actorId, v.sourceId ?? '', 'manage')
  const id = `override:${p.viewId}:${p.principalId}`
  const have = cx.d.get('event', id)
  const data = { personalFilter: p.personalFilter ?? null, personalSorts: p.personalSorts ?? null, displayState: p.displayState ?? null }
  if (have) cx.d.mut('event', id).data = data as unknown as Json
  else cx.d.add('event', { ...cx.meta(id), type: 'audit', pageId: null, principalId: p.principalId, data: { kind: 'view_override', viewId: p.viewId, ...data } as unknown as Json })
})

