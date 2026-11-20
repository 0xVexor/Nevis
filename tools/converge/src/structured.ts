// M7 operations of the convergence harness, through the DOMAIN API of the core (the same functions the app calls): databases,
// properties of all eight types, select options, rows and cells, views, tags, saved searches, settings, and moves in the page tree
// (which also makes cycles). Every op is counted by name so a branch that never runs cannot pass unnoticed.
import {
  addOption, addProperty, createDatabase, createRow, createSavedSearch, createTag, createView, movePage, readStructured, removeOption, renameProperty, setCell, setMembers, setSetting,
  setViewConfig, tagPage, trashProperty, trashRow, trashView, updateOption, updateSavedSearch, updateTag, PROP_TYPES, type PropType,
} from '@nevis/core'
import { int, pick, type Rng } from './rng'
import type { Replica } from './replica'

export interface DbInfo { id: string; titleProp: string; props: { id: string; type: PropType }[]; rows: string[]; views: string[]; opts: Map<string, string[]> }
export interface StructuredWorld { dbs: DbInfo[]; tags: string[]; searches: string[]; counts: Record<string, number> }

/** Every op name the harness must have run at least once in a long run (see the check in cli.ts). */
export const EXPECTED_OPS = [
  'setCell:text', 'setCell:number', 'setCell:date', 'setCell:select', 'setCell:checkbox', 'setCell:url', 'setCell:clear', 'setMembers:multiSelect', 'setMembers:relation',
  'addOption', 'updateOption', 'removeOption', 'addProperty', 'renameProperty', 'trashProperty', 'createRow', 'trashRow', 'createView', 'setViewConfig', 'trashView',
  'createTag', 'updateTag', 'tagPage', 'savedSearch', 'setSetting', 'movePage', 'createDatabase',
]

/** Runs `fn` and records every outbox row it added as an op this device produced (the server log must hold each exactly once). */
export async function recorded(rep: Replica, fn: () => Promise<unknown>): Promise<number> {
  const seen = new Set((await rep.store.run(tx => tx.listOutbox(1e9))).map(r => r.op))
  await fn()
  let n = 0
  for (const r of await rep.store.run(tx => tx.listOutbox(1e9))) if (!seen.has(r.op)) { rep.record(r.op); n++ }
  return n
}

const FA_NUM = ['۱۲٫۵', '۱٬۲۳۴٬۵۶۷', '-۰۰۷', '3.14159', '0', '۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹٫۱', '.5']
const DATES = ['2026-11-20', '۱۴۰۵/۰۸/۲۹', '2024-02-29', '2026-03-21T08:30:00Z', '1403-12-30']
const WORDS = ['کتاب', 'یادداشت', 'hello', 'Nevis', 'می‌خواهم', '۱۲۳']

async function newDb(rep: Replica, rng: Rng, w: StructuredWorld, pages: string[], full: boolean): Promise<DbInfo> {
  const c = rep.client
  const db = await createDatabase(c, { title: pick(rng, WORDS) })
  const info: DbInfo = { id: db.id, titleProp: db.titleProp, props: [{ id: db.titleProp, type: 'text' }], rows: [], views: [], opts: new Map() }
  if (full) {
    for (const type of PROP_TYPES) {
      if (type === 'text') continue
      const id = await addProperty(c, db.id, { name: type, type, ...(type === 'relation' ? { config: { target: db.id } } : {}) })
      info.props.push({ id, type })
      if (type === 'select' || type === 'multiSelect') { const o: string[] = []; for (let i = 0; i < 3; i++) o.push(await addOption(c, id, { name: pick(rng, WORDS) })); info.opts.set(id, o) }
    }
    for (let i = 0; i < 4; i++) info.rows.push(await createRow(c, db.id))
    info.views.push(await createView(c, db.id, { name: 'برد', type: 'board', config: { groupBy: info.props[3]!.id } }))
  }
  w.dbs.push(info)
  pages.push(db.id)
  return info
}

/** The same start for every seed: two databases with every property type, tags and a saved search, created on R1 and handed to all. */
export async function setupStructured(reps: Replica[], rng: Rng, pages: string[]): Promise<StructuredWorld> {
  const w: StructuredWorld = { dbs: [], tags: [], searches: [], counts: {} }
  await recorded(reps[0]!, async () => {
    await newDb(reps[0]!, rng, w, pages, true)
    await newDb(reps[0]!, rng, w, pages, true)
    for (let i = 0; i < 3; i++) w.tags.push(await createTag(reps[0]!.client, { name: pick(rng, WORDS) }))
    w.searches.push(await createSavedSearch(reps[0]!.client, { name: 'س', query: 'q' }))
  })
  // relations point at rows of the same database
  for (let pass = 0; pass < 2; pass++) for (const r of reps) { r.net.enabled = false; await r.sync(); r.net.enabled = true }
  return w
}

export interface Ctx { rep: Replica; rng: Rng; w: StructuredWorld; pages: string[]; docs: string[] }

const count = (w: StructuredWorld, name: string, n: number) => { if (n > 0) w.counts[name] = (w.counts[name] ?? 0) + 1 }

export async function structuredOp({ rep, rng, w, pages, docs }: Ctx): Promise<void> {
  const c = rep.client
  const db = pick(rng, w.dbs)
  const prop = pick(rng, db.props)
  const row = db.rows.length ? pick(rng, db.rows) : null
  const r = rng()
  const run = async (name: string, fn: () => Promise<unknown>) => count(w, name, await recorded(rep, fn))

  if (r < 0.30 && row) {
    const p = pick(rng, db.props)
    const clear = rng() < 0.12
    switch (p.type) {
      case 'multiSelect':
      case 'relation': {
        const pool = p.type === 'relation' ? db.rows : db.opts.get(p.id) ?? []
        if (!pool.length) return
        const m: Record<string, boolean> = {}
        for (let i = 0, n = 1 + int(rng, 2); i < n; i++) m[pick(rng, pool)] = rng() < 0.6
        return run(`setMembers:${p.type}`, () => setMembers(c, row, p.id, m))
      }
      default: {
        const value = clear ? null : p.type === 'number' ? pick(rng, FA_NUM) : p.type === 'date' ? pick(rng, DATES) : p.type === 'checkbox' ? rng() < 0.5 : p.type === 'select' ? pick(rng, db.opts.get(p.id) ?? [null as never]) ?? null : p.type === 'url' ? `https://${pick(rng, ['a', 'b', 'c'])}.example/${int(rng, 99)}` : pick(rng, WORDS)
        return run(clear ? 'setCell:clear' : `setCell:${p.type}`, () => setCell(c, row, p, value))
      }
    }
  }
  if (r < 0.40) { // options
    const sel = db.props.filter(p => p.type === 'select' || p.type === 'multiSelect')
    if (!sel.length) return
    const p = pick(rng, sel)
    const opts = db.opts.get(p.id) ?? []
    const k = rng()
    if (k < 0.45 || !opts.length) return run('addOption', async () => { const id = await addOption(c, p.id, { name: pick(rng, WORDS), color: pick(rng, ['red', 'blue', 'gray']) }); opts.push(id); db.opts.set(p.id, opts) })
    if (k < 0.85) return run('updateOption', () => updateOption(c, p.id, pick(rng, opts), rng() < 0.5 ? { name: pick(rng, WORDS) } : { color: pick(rng, ['red', 'blue', 'green']) }))
    return run('removeOption', () => removeOption(c, p.id, pick(rng, opts)))
  }
  if (r < 0.47) { // properties
    const k = rng()
    if (k < 0.4) return run('addProperty', async () => { const type = pick(rng, PROP_TYPES); const id = await addProperty(c, db.id, { name: pick(rng, WORDS), type, ...(type === 'relation' ? { config: { target: db.id } } : {}) }); db.props.push({ id, type }); if (type === 'select' || type === 'multiSelect') db.opts.set(id, []) })
    if (k < 0.7) return run('renameProperty', () => renameProperty(c, prop.id, pick(rng, WORDS)))
    return run('trashProperty', () => trashProperty(c, prop.id, rng() < 0.7))
  }
  if (r < 0.56) { // rows
    if (!row || rng() < 0.5) return run('createRow', async () => { const id = await createRow(c, db.id, rng() < 0.3 ? { cells: { [`c:${db.titleProp}`]: pick(rng, WORDS) } } : {}); db.rows.push(id); docs.push(id) })
    return run('trashRow', () => trashRow(c, row, rng() < 0.6))
  }
  if (r < 0.62) { // views
    const k = rng()
    if (k < 0.3) return run('createView', async () => { db.views.push(await createView(c, db.id, { name: pick(rng, WORDS), type: pick(rng, ['table', 'board'] as const) })) })
    if (!db.views.length) return
    if (k < 0.85) return run('setViewConfig', () => setViewConfig(c, pick(rng, db.views), { filter: pick(rng, WORDS), sort: [{ p: prop.id, dir: rng() < 0.5 ? 'asc' : 'desc' }], hidden: [prop.id] }))
    return run('trashView', () => trashView(c, pick(rng, db.views), rng() < 0.7))
  }
  if (r < 0.70) { // tags, searches, settings
    const k = rng()
    if (k < 0.15) return run('createTag', async () => { w.tags.push(await createTag(c, { name: pick(rng, WORDS) })) })
    if (k < 0.3) return run('updateTag', () => updateTag(c, pick(rng, w.tags), rng() < 0.5 ? { name: pick(rng, WORDS) } : { color: pick(rng, ['red', 'blue']) }))
    if (k < 0.65) return run('tagPage', () => tagPage(c, pick(rng, pages), pick(rng, w.tags), rng() < 0.65))
    if (k < 0.8) return run('savedSearch', async () => { if (rng() < 0.3) w.searches.push(await createSavedSearch(c, { name: pick(rng, WORDS), query: pick(rng, WORDS) })); else await updateSavedSearch(c, pick(rng, w.searches), rng() < 0.5 ? { query: pick(rng, WORDS) } : { trashed: rng() < 0.5 }) })
    return run('setSetting', () => setSetting(c, pick(rng, ['theme', 'lang', 'weekStart', 'font']), pick(rng, WORDS)))
  }
  if (r < 0.96) { // tree moves: pages AND databases, any parent (cycles included)
    const id = pick(rng, pages)
    const parent = rng() < 0.2 ? '' : pick(rng, pages)
    return run('movePage', () => movePage(c, id, parent, null, null))
  }
  return run('createDatabase', async () => { await newDb(rep, rng, w, pages, false) })
}

/** The derived projection of a store as plain JSON (Maps -> arrays): equal on every replica, whatever order ops arrived in. */
export async function derived(rep: { store: Replica['store'] }): Promise<string> {
  const s = await readStructured(rep.store)
  return JSON.stringify({ pages: s.pages, dbs: [...s.databases.values()], tags: s.tags, ss: s.savedSearches, settings: s.settings, pt: [...s.pageTags] })
}
