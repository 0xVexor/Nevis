// Structured data (ADR-0002, ADR-0004): databases, properties, select options, views, rows and their cells, tags, saved searches
// and the synced settings. Everything is a register of an entity (LWW per field) written through `Client.setFields`; there is no
// merge code here, only the SHAPE of the data (docs/formats/records-v1.md) and a projection that reads it back.
//
// Rules this file keeps:
//  - fields are flat; a set is one register per element (`opt:<id>`, `c:<prop>/<elem>`, `tag:<id>`), never an array;
//  - nothing cascades: trashing a database or a property, or removing an option, only hides things; rows and cells are never rewritten;
//  - the projection tolerates partial and odd data (another device may have pushed only some of the ops of a database, a cell may not
//    match its property's type, a relation may point at a row that does not exist) and never depends on the order rows come in.
import type { Json } from '@nevis/protocol'
import type { Client } from './client'
import { KIND_FIELD } from './apply'
import { normalizeDate } from './dates'
import { normalizeDecimal } from './decimal'
import { sortKeyBetween } from './sortKey'
import type { PageRow } from './tree'
import type { Store } from './store'

export const KINDS = { page: 'page', database: 'database', property: 'property', view: 'view', row: 'row', tag: 'tag', savedSearch: 'savedSearch', settings: 'settings' } as const
export const PROP_TYPES = ['text', 'number', 'date', 'select', 'multiSelect', 'relation', 'checkbox', 'url'] as const
export type PropType = (typeof PROP_TYPES)[number]
export const VIEW_TYPES = ['table', 'board'] as const
export type ViewType = (typeof VIEW_TYPES)[number]

export class InvalidCell extends Error {
  readonly type: PropType
  constructor(type: PropType, input: unknown) { super(`not a valid ${type}: ${String(input)}`); this.type = type }
}

// ---------------------------------------------------------------------------------------------------------------- reading

export interface OptionModel { id: string; name: string; color: string; sortKey: string }
export interface PropertyModel { id: string; db: string; name: string; type: PropType; config: Json; sortKey: string; trashed: boolean; isTitle: boolean; options: OptionModel[] }
export interface ViewModel { id: string; db: string; name: string; type: ViewType; config: Json; sortKey: string; trashed: boolean }
/** text/url/date/number: string|null · checkbox: boolean · select: option id|null · multiSelect and relation: ids (sorted) */
export type CellValue = string | boolean | null | string[]
export interface RowModel { id: string; db: string; sortKey: string; trashed: boolean; createdAt: number; cells: Record<string, CellValue>; title: string }
export interface DatabaseModel { id: string; title: string; parent: string; sortKey: string; trashed: boolean; properties: PropertyModel[]; views: ViewModel[]; rows: RowModel[] }
export interface TagModel { id: string; name: string; color: string }
export interface SavedSearchModel { id: string; name: string; query: string; sortKey: string; trashed: boolean }
export interface Structured {
  /** pages AND databases (a database is a node of the page tree) */
  pages: PageRow[]
  databases: Map<string, DatabaseModel>
  tags: TagModel[]
  savedSearches: SavedSearchModel[]
  settings: Record<string, Json>
  /** page id -> tag ids that are ON */
  pageTags: Map<string, string[]>
}

type F = Map<string, { val: string; hlc: string }>
const j = (m: F, f: string): unknown => { const r = m.get(f); if (!r) return undefined; try { return JSON.parse(r.val) } catch { return undefined } }
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const order = <T extends { sortKey: string; id: string }>(a: T, b: T) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const isType = (v: unknown): v is PropType => (PROP_TYPES as readonly unknown[]).includes(v)
const asIds = (set: Set<string>) => [...set].sort()

/** Reads every structured record from ONE bulk read of the registers. The result does not depend on the order of the rows
 *  the store returns or on the order the ops were applied in. */
export async function readStructured(store: Store): Promise<Structured> {
  const all = await store.run(tx => tx.allFields())
  const by = new Map<string, F>()
  for (const r of all) {
    let m = by.get(r.ent)
    if (!m) by.set(r.ent, (m = new Map()))
    m.set(r.f, r)
  }
  const pages: PageRow[] = []
  const dbs = new Map<string, DatabaseModel>()
  const props: PropertyModel[] = []
  const views: ViewModel[] = []
  const rows: { id: string; m: F }[] = []
  const tags: TagModel[] = []
  const searches: SavedSearchModel[] = []
  const pageTags = new Map<string, string[]>()
  let settings: Record<string, Json> = {}

  for (const [id, m] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kind = j(m, KIND_FIELD)
    switch (kind) {
      case KINDS.page:
      case KINDS.database: {
        pages.push({
          id, title: str(j(m, 'title')), parent: str(j(m, 'parent')), sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true,
          kind: str(j(m, 'kind'), 'doc'), createdAt: Number(j(m, 'createdAt') ?? 0), parentHlc: m.get('parent')?.hlc ?? '', type: kind,
          icon: str(j(m, 'icon')), status: str(j(m, 'status')), favorite: j(m, 'favorite') === true, cover: m.has('cover') ? JSON.stringify(j(m, 'cover')) : '',
        })
        const on = new Set<string>()
        for (const [f] of m) if (f.startsWith('tag:') && j(m, f) === true) on.add(f.slice(4))
        if (on.size) pageTags.set(id, asIds(on))
        if (kind === KINDS.database) dbs.set(id, { id, title: str(j(m, 'title')), parent: str(j(m, 'parent')), sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true, properties: [], views: [], rows: [] })
        break
      }
      case KINDS.property: {
        const options: OptionModel[] = []
        for (const [f] of m) {
          if (!f.startsWith('opt:')) continue
          const v = j(m, f) as { name?: unknown; color?: unknown; sortKey?: unknown } | null | undefined
          if (v && typeof v === 'object' && !Array.isArray(v)) options.push({ id: f.slice(4), name: str(v.name), color: str(v.color), sortKey: str(v.sortKey) })
        }
        const config = (j(m, 'config') ?? {}) as Json
        props.push({
          id, db: str(j(m, 'db')), name: str(j(m, 'name')), type: isType(j(m, 'type')) ? (j(m, 'type') as PropType) : 'text', config,
          sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true, isTitle: !!config && typeof config === 'object' && !Array.isArray(config) && config.title === true, options: options.sort(order),
        })
        break
      }
      case KINDS.view:
        views.push({ id, db: str(j(m, 'db')), name: str(j(m, 'name')), type: (VIEW_TYPES as readonly unknown[]).includes(j(m, 'type')) ? (j(m, 'type') as ViewType) : 'table', config: (j(m, 'config') ?? {}) as Json, sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true })
        break
      case KINDS.row: rows.push({ id, m }); break
      case KINDS.tag: tags.push({ id, name: str(j(m, 'name')), color: str(j(m, 'color')) }); break
      case KINDS.savedSearch: searches.push({ id, name: str(j(m, 'name')), query: str(j(m, 'query')), sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true }); break
      case KINDS.settings: {
        const s: Record<string, Json> = {}
        for (const [f] of [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (f !== KIND_FIELD) s[f] = (j(m, f) ?? null) as Json
        settings = { ...settings, ...s }
        break
      }
    }
  }

  for (const p of props) dbs.get(p.db)?.properties.push(p)
  for (const v of views) dbs.get(v.db)?.views.push(v)
  for (const db of dbs.values()) { db.properties.sort(order); db.views.sort(order) }
  for (const { id, m } of rows) {
    const dbId = str(j(m, 'db'))
    const db = dbs.get(dbId)
    if (!db) continue // a row whose database has not arrived (or never will): nothing to show it in
    const cells: Record<string, CellValue> = {}
    for (const p of db.properties) cells[p.id] = readCell(m, p)
    const titleProp = titleProperty(db.properties)
    const t = titleProp ? cells[titleProp.id] : ''
    db.rows.push({ id, db: dbId, sortKey: str(j(m, 'sortKey')), trashed: j(m, 'trashed') === true, createdAt: Number(j(m, 'createdAt') ?? 0), cells, title: typeof t === 'string' ? t : '' })
  }
  for (const db of dbs.values()) db.rows.sort(order)
  tags.sort((a, b) => (a.id < b.id ? -1 : 1))
  searches.sort(order)
  return { pages, databases: dbs, tags, savedSearches: searches, settings, pageTags }
}

/** The title property: the one marked `config.title`; with none or several, the first by (sortKey, id). Deterministic on every device. */
export function titleProperty(props: readonly PropertyModel[]): PropertyModel | undefined {
  const live = props.filter(p => !p.trashed)
  return live.find(p => p.isTitle) ?? live[0]
}

function readCell(m: F, p: PropertyModel): CellValue {
  switch (p.type) {
    case 'multiSelect':
    case 'relation': {
      const on = new Set<string>()
      const prefix = `c:${p.id}/`
      for (const [f] of m) if (f.startsWith(prefix) && j(m, f) === true) on.add(f.slice(prefix.length))
      if (p.type === 'relation') return asIds(on)
      // by option order, ids of options that no longer exist last (by id): the same on every device
      const rank = new Map(p.options.map((o, i) => [o.id, i]))
      return [...on].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : 1))
    }
    case 'checkbox': return j(m, `c:${p.id}`) === true
    case 'number': { const v = j(m, `c:${p.id}`); return typeof v === 'string' ? normalizeDecimal(v) ?? null : null }
    case 'select': { const v = j(m, `c:${p.id}`); return typeof v === 'string' ? v : null }
    default: { const v = j(m, `c:${p.id}`); return typeof v === 'string' ? v : null }
  }
}

/** Rows (of any database) that point at `rowId` through a relation property: derived, never stored on the other side. */
export function backlinks(s: Structured, rowId: string): { row: string; property: string }[] {
  const out: { row: string; property: string }[] = []
  for (const db of s.databases.values()) for (const p of db.properties) if (p.type === 'relation' && !p.trashed) for (const r of db.rows) if (!r.trashed && (r.cells[p.id] as string[]).includes(rowId)) out.push({ row: r.id, property: p.id })
  return out.sort((a, b) => (a.row + a.property < b.row + b.property ? -1 : 1))
}

// ---------------------------------------------------------------------------------------------------------------- writing

const last = (keys: string[]): string | null => (keys.length ? keys.sort()[keys.length - 1]! : null)

async function lastSortKey(store: Store, filter: (m: F) => boolean): Promise<string | null> {
  const all = await store.run(tx => tx.allFields())
  const by = new Map<string, F>()
  for (const r of all) { let m = by.get(r.ent); if (!m) by.set(r.ent, (m = new Map())); m.set(r.f, r) }
  return last([...by.values()].filter(filter).map(m => str(j(m, 'sortKey'))).filter(Boolean))
}

export interface NewDatabase { title?: string; parent?: string; before?: string | null; after?: string | null; titlePropertyName?: string }

/** A database with its title property and a first table view, in ONE local transaction. Other devices may see the three ops one at a time. */
export async function createDatabase(c: Client, o: NewDatabase = {}): Promise<{ id: string; titleProp: string; view: string }> {
  const id = c.newIdFor(), titleProp = c.newIdFor(), view = c.newIdFor(), now = c.nowMs()
  await c.setFieldsMany([
    { ent: id, kind: KINDS.database, set: { title: o.title ?? '', parent: o.parent ?? '', sortKey: sortKeyBetween(o.before ?? null, o.after ?? null, c.rnd), trashed: false, kind: 'doc', createdAt: now } },
    { ent: titleProp, kind: KINDS.property, set: { db: id, name: o.titlePropertyName ?? 'نام', type: 'text', config: { title: true }, sortKey: sortKeyBetween(null, null, c.rnd), trashed: false, createdAt: now } },
    { ent: view, kind: KINDS.view, set: { db: id, name: 'جدول', type: 'table', config: {}, sortKey: sortKeyBetween(null, null, c.rnd), trashed: false, createdAt: now } },
  ])
  return { id, titleProp, view }
}

export async function addProperty(c: Client, db: string, o: { name: string; type: PropType; config?: Json }): Promise<string> {
  const id = c.newIdFor()
  const prev = await lastSortKey(c.store, m => j(m, KIND_FIELD) === KINDS.property && j(m, 'db') === db)
  await c.setFields(id, { db, name: o.name, type: o.type, config: o.config ?? (o.type === 'relation' ? { target: '' } : {}), sortKey: sortKeyBetween(prev, null, c.rnd), trashed: false, createdAt: c.nowMs() }, KINDS.property)
  return id
}
export const renameProperty = (c: Client, id: string, name: string) => c.setFields(id, { name })
export const setPropertyConfig = (c: Client, id: string, config: Json) => c.setFields(id, { config })
export const trashProperty = (c: Client, id: string, trashed = true) => c.setFields(id, { trashed })

/** A select option is `opt:<id>` = {name,color,sortKey} on the property. Two devices adding options at once both keep theirs. */
export async function addOption(c: Client, prop: string, o: { name: string; color?: string }): Promise<string> {
  const id = c.newIdFor()
  const fields = await c.store.run(tx => tx.entityFields(prop))
  const keys = Object.entries(fields).filter(([f, r]) => f.startsWith('opt:') && r.val !== 'null').map(([, r]) => str((JSON.parse(r.val) as { sortKey?: unknown }).sortKey)).filter(Boolean)
  await c.setFields(prop, { [`opt:${id}`]: { name: o.name, color: o.color ?? 'gray', sortKey: sortKeyBetween(last(keys), null, c.rnd) } })
  return id
}
/** The whole `opt:` value is one register: a rename and a recolor made at the same time lose one of the two (ADR-0004: documented). */
export async function updateOption(c: Client, prop: string, id: string, patch: { name?: string; color?: string }): Promise<void> {
  const cur = (await c.store.run(tx => tx.getField(prop, `opt:${id}`)))
  const v = cur ? (JSON.parse(cur.val) as { name: string; color: string; sortKey: string } | null) : null
  if (!v) return
  await c.setFields(prop, { [`opt:${id}`]: { ...v, ...patch } })
}
/** `null` = removed. Cells that hold the option are not touched; the projection just shows no option for them. */
export const removeOption = (c: Client, prop: string, id: string) => c.setFields(prop, { [`opt:${id}`]: null })

export async function createView(c: Client, db: string, o: { name: string; type?: ViewType; config?: Json }): Promise<string> {
  const id = c.newIdFor()
  const prev = await lastSortKey(c.store, m => j(m, KIND_FIELD) === KINDS.view && j(m, 'db') === db)
  await c.setFields(id, { db, name: o.name, type: o.type ?? 'table', config: o.config ?? {}, sortKey: sortKeyBetween(prev, null, c.rnd), trashed: false, createdAt: c.nowMs() }, KINDS.view)
  return id
}
/** The config is ONE value: two devices changing filter and sort of the same view at once keep only one of the two (documented). */
export const setViewConfig = (c: Client, id: string, config: Json) => c.setFields(id, { config })
export const renameView = (c: Client, id: string, name: string) => c.setFields(id, { name })
export const trashView = (c: Client, id: string, trashed = true) => c.setFields(id, { trashed })

export async function createRow(c: Client, db: DatabaseModel | string, o: { cells?: Record<string, Json>; before?: string | null; after?: string | null } = {}): Promise<string> {
  const id = c.newIdFor()
  const dbId = typeof db === 'string' ? db : db.id
  const prev = o.after !== undefined || o.before !== undefined ? null : await lastSortKey(c.store, m => j(m, KIND_FIELD) === KINDS.row && j(m, 'db') === dbId)
  await c.setFields(id, { db: dbId, sortKey: sortKeyBetween(o.before ?? prev, o.after ?? null, c.rnd), trashed: false, createdAt: c.nowMs(), ...(o.cells ?? {}) }, KINDS.row)
  return id
}
export const trashRow = (c: Client, id: string, trashed = true) => c.setFields(id, { trashed })

/** The fields that set one cell of a single-value type. Numbers and dates are normalized; what cannot be read throws `InvalidCell`
 *  (nothing is written). `null` or '' clears. */
export function cellFields(p: Pick<PropertyModel, 'id' | 'type'>, value: string | boolean | null): Record<string, Json> {
  const f = `c:${p.id}`
  const empty = value === null || value === ''
  switch (p.type) {
    case 'number': { if (empty) return { [f]: null }; const n = typeof value === 'string' ? normalizeDecimal(value) : null; if (n === null) throw new InvalidCell('number', value); return { [f]: n } }
    case 'date': { if (empty) return { [f]: null }; const d = typeof value === 'string' ? normalizeDate(value) : null; if (d === null) throw new InvalidCell('date', value); return { [f]: d } }
    case 'checkbox': return { [f]: value === true }
    case 'select': return { [f]: empty ? null : String(value) }
    case 'text':
    case 'url': return { [f]: empty ? null : String(value) }
    default: throw new InvalidCell(p.type, value) // multiSelect and relation are sets: use setMembers
  }
}
export async function setCell(c: Client, row: string, p: Pick<PropertyModel, 'id' | 'type'>, value: string | boolean | null): Promise<string> {
  return c.setFields(row, cellFields(p, value)) // throws InvalidCell before anything is written
}
/** Adds or removes elements of a multi-select or relation cell: one register per element, so concurrent changes of different elements both stay. */
export const setMembers = (c: Client, row: string, prop: string, members: Record<string, boolean>) => c.setFields(row, Object.fromEntries(Object.entries(members).map(([elem, on]) => [`c:${prop}/${elem}`, on])))

export async function createTag(c: Client, o: { name: string; color?: string }): Promise<string> {
  const id = c.newIdFor()
  await c.setFields(id, { name: o.name, color: o.color ?? 'gray', createdAt: c.nowMs() }, KINDS.tag)
  return id
}
export const updateTag = (c: Client, id: string, patch: { name?: string; color?: string }) => c.setFields(id, patch)
export const tagPage = (c: Client, page: string, tag: string, on: boolean) => c.setFields(page, { [`tag:${tag}`]: on })

export async function createSavedSearch(c: Client, o: { name: string; query: string }): Promise<string> {
  const id = c.newIdFor()
  const prev = await lastSortKey(c.store, m => j(m, KIND_FIELD) === KINDS.savedSearch)
  await c.setFields(id, { name: o.name, query: o.query, sortKey: sortKeyBetween(prev, null, c.rnd), trashed: false, createdAt: c.nowMs() }, KINDS.savedSearch)
  return id
}
export const updateSavedSearch = (c: Client, id: string, patch: { name?: string; query?: string; trashed?: boolean }) => c.setFields(id, patch)

/** Synced settings of the workspace: the entity id is the workspace id, one register per setting. */
export const setSetting = (c: Client, key: string, value: Json) => c.setFields(c.ws, { [key]: value }, KINDS.settings)

/** Moves a card on a board: the select value and the position change in ONE op (the way `movePage` writes parent and sortKey), so they win or lose
 *  together. `before`/`after` are the sort keys of the neighbours in the target column; `option` '' = the "no value" column. */
export async function moveCard(c: Client, row: string, prop: string, option: string, before: string | null, after: string | null): Promise<string> {
  return c.setFields(row, { [`c:${prop}`]: option === '' ? null : option, sortKey: sortKeyBetween(before, after, c.rnd) })
}
