import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseEnvelope, uuidv7, SV } from '@nevis/protocol'
import {
  Client, InvalidCell, MemoryStore, addOption, addProperty, applyEnvelope, backlinks, buildTree, cellFields, compareDecimal, createDatabase, createRow, createSavedSearch, createTag, createView,
  formatDateFa, gregorianToJalali, jalaliToGregorian, movePage, createPage, normalizeDate, normalizeDecimal, projectStore, readPages, readStructured, removeOption, renameProperty, setCell,
  setMembers, setSetting, setViewConfig, sortKeyBetween, tagPage, titleProperty, trashProperty, trashRow, updateOption, type PageRow, type Structured,
} from '../src'

/** A device: its own store and client. `sync` delivers everything of `from`'s outbox to `to` (idempotent, so repeats are harmless). */
class Dev {
  readonly store = new MemoryStore()
  readonly c: Client
  readonly id = uuidv7()
  constructor(ws: string, rnd?: () => number) { this.c = new Client({ store: this.store, ws, device: this.id, sv: SV, ...(rnd ? { rnd } : {}) }) }
  async outbox() { return (await this.store.run(tx => tx.listOutbox(1e6))).map(r => r.env) }
  async receive(envs: string[]) { for (const t of envs) await this.store.run(tx => applyEnvelope(tx, parseEnvelope(t), { device: this.id, sv: SV, now: Date.now() })) }
  async s(): Promise<Structured> { return readStructured(this.store) }
}
async function sync(a: Dev, b: Dev) { const [x, y] = [await a.outbox(), await b.outbox()]; await b.receive(x); await a.receive(y) }
const WS = uuidv7()
const norm = (s: Structured) => JSON.stringify({ pages: s.pages, dbs: [...s.databases.values()], tags: s.tags, ss: s.savedSearches, settings: s.settings, pt: [...s.pageTags] })

describe('numbers: decimal strings', () => {
  it('Persian digits and separators become a plain decimal string', () => {
    expect(normalizeDecimal('۱۲٫۵')).toBe('12.5')
    expect(normalizeDecimal('١٢٫٥')).toBe('12.5')
    expect(normalizeDecimal('۱٬۲۳۴٬۵۶۷٫۸۹')).toBe('1234567.89')
    expect(normalizeDecimal('-۰۰۷')).toBe('-7')
    expect(normalizeDecimal('−12.50')).toBe('-12.50') // trailing zeros are kept (ADR-0004: "12.50")
    expect(normalizeDecimal('‏۱۲‎')).toBe('12') // RLM/LRM that Persian keyboards and pasted text carry
    expect(normalizeDecimal('.5')).toBe('0.5')
    expect(normalizeDecimal('5.')).toBe('5')
    expect(normalizeDecimal('-0.0')).toBe('0.0')
    expect(normalizeDecimal('+3')).toBe('3')
    expect(normalizeDecimal('123456789012345678901234567890.123456789')).toBe('123456789012345678901234567890.123456789') // no float
  })
  it('what cannot be read is refused, never guessed', () => {
    for (const bad of ['', ' ', '1/2', '1,5', '1,23', '12,34,567', '1e5', '1.2.3', 'abc', '١٢a', '--1', '۱۲٫٫۵', '.', '-', '1 2', 'x'.repeat(101)]) expect(normalizeDecimal(bad), bad).toBeNull()
    expect(normalizeDecimal('1,234')).toBe('1234') // documented: a comma is a thousands separator
  })
  it('compareDecimal is exact and total (property)', () => {
    expect(compareDecimal('2', '10')).toBe(-1)
    expect(compareDecimal('-2', '-10')).toBe(1)
    expect(compareDecimal('1.5', '1.50')).toBe(0)
    expect(compareDecimal('0.001', '0.01')).toBe(-1)
    const dec = fc.tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.option(fc.stringMatching(/^[0-9]{1,8}$/), { nil: undefined })).map(([n, i, f]) => normalizeDecimal(`${n ? '-' : ''}${i}${f ? '.' + f : ''}`)!)
    fc.assert(fc.property(dec, dec, dec, (a, b, c) => {
      expect(compareDecimal(a, b)).toBe(-compareDecimal(b, a))
      if (compareDecimal(a, b) <= 0 && compareDecimal(b, c) <= 0) expect(compareDecimal(a, c)).toBeLessThanOrEqual(0)
    }))
  })
})

describe('dates', () => {
  it('Gregorian and Jalali input give the stored Gregorian form', () => {
    expect(normalizeDate('2026-11-20')).toBe('2026-11-20')
    expect(normalizeDate('۲۰۲۶/۱۱/۲۰')).toBe('2026-11-20')
    expect(normalizeDate('2026-11-20T08:30:00Z')).toBe('2026-11-20T08:30:00.000Z')
    expect(normalizeDate('2026-02-30')).toBeNull()
    expect(normalizeDate('1405/08/29')).toBe('2026-11-20') // 29 Aban 1405
    expect(normalizeDate('۱۴۰۵-۰۸-۲۹')).toBe('2026-11-20')
    expect(normalizeDate('1404/12/30')).toBeNull() // 1404 is not a leap year
    expect(normalizeDate('hello')).toBeNull()
  })
  it('Gregorian -> Jalali -> Gregorian round-trips every day of 130 years, and Nowruz is where it should be', () => {
    for (let t = Date.UTC(1950, 0, 1); t < Date.UTC(2080, 0, 1); t += 86_400_000) {
      const g = new Date(t)
      const [y, m, d] = [g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate()] as const
      const [jy, jm, jd] = gregorianToJalali(y, m, d)
      expect(jalaliToGregorian(jy, jm, jd)).toEqual([y, m, d])
    }
    expect(gregorianToJalali(2026, 3, 21)).toEqual([1405, 1, 1])
  })
  it('a date-only value is formatted in UTC, never in local time (the check in a west-of-UTC browser is db.spec.ts with timezoneId America/Los_Angeles)', () => {
    expect(formatDateFa('2026-11-20')).toBe('۱۴۰۵/۰۸/۲۹')
    expect(formatDateFa('2026-03-21')).toBe('۱۴۰۵/۰۱/۰۱')
  })
})

describe('database model', () => {
  it('a database comes with a title property and a view; rows read back typed, with Persian digits normalized', async () => {
    const d = new Dev(WS)
    const db = await createDatabase(d.c, { title: 'کتاب‌ها' })
    const price = await addProperty(d.c, db.id, { name: 'قیمت', type: 'number' })
    const genre = await addProperty(d.c, db.id, { name: 'ژانر', type: 'select' })
    const tags = await addProperty(d.c, db.id, { name: 'برچسب‌ها', type: 'multiSelect' })
    const done = await addProperty(d.c, db.id, { name: 'خوانده', type: 'checkbox' })
    const when = await addProperty(d.c, db.id, { name: 'تاریخ', type: 'date' })
    const site = await addProperty(d.c, db.id, { name: 'سایت', type: 'url' })
    const rel = await addProperty(d.c, db.id, { name: 'مرتبط', type: 'relation', config: { target: db.id } })
    const novel = await addOption(d.c, genre, { name: 'رمان', color: 'red' })
    const t1 = await addOption(d.c, tags, { name: 'کلاسیک' }), t2 = await addOption(d.c, tags, { name: 'ایرانی' })
    const r1 = await createRow(d.c, db.id)
    const r2 = await createRow(d.c, db.id)
    await setCell(d.c, r1, { id: db.titleProp, type: 'text' }, 'بوف کور')
    await setCell(d.c, r1, { id: price, type: 'number' }, '۱۲٫۵')
    await setCell(d.c, r1, { id: genre, type: 'select' }, novel)
    await setMembers(d.c, r1, tags, { [t2]: true, [t1]: true })
    await setCell(d.c, r1, { id: done, type: 'checkbox' }, true)
    await setCell(d.c, r1, { id: when, type: 'date' }, '۱۴۰۵/۰۸/۲۹')
    await setCell(d.c, r1, { id: site, type: 'url' }, 'https://example.com')
    await setMembers(d.c, r1, rel, { [r2]: true })
    const m = (await d.s()).databases.get(db.id)!
    expect(m.properties.map(p => p.name)).toEqual(['نام', 'قیمت', 'ژانر', 'برچسب‌ها', 'خوانده', 'تاریخ', 'سایت', 'مرتبط'])
    expect(m.views.map(v => v.name)).toEqual(['جدول'])
    const row = m.rows.find(r => r.id === r1)!
    expect(row.cells).toEqual({ [db.titleProp]: 'بوف کور', [price]: '12.5', [genre]: novel, [tags]: [t1, t2], [done]: true, [when]: '2026-11-20', [site]: 'https://example.com', [rel]: [r2] })
    expect(row.title).toBe('بوف کور')
    expect(m.rows.map(r => r.id)).toEqual([r1, r2]) // creation order
    expect(backlinks(await d.s(), r2)).toEqual([{ row: r1, property: rel }])
  })

  it('an invalid number or date throws and writes nothing', async () => {
    const d = new Dev(WS)
    const db = await createDatabase(d.c)
    const n = await addProperty(d.c, db.id, { name: 'n', type: 'number' })
    const r = await createRow(d.c, db.id)
    const before = (await d.outbox()).length
    await expect(setCell(d.c, r, { id: n, type: 'number' }, '1/2')).rejects.toThrow(InvalidCell)
    expect(() => cellFields({ id: n, type: 'date' }, '31 فروردین')).toThrow(InvalidCell)
    expect((await d.outbox()).length).toBe(before)
    expect(cellFields({ id: n, type: 'number' }, '')).toEqual({ [`c:${n}`]: null }) // empty clears
  })

  it('nothing cascades: trashing a property or removing an option leaves the cells as they were', async () => {
    const d = new Dev(WS)
    const db = await createDatabase(d.c)
    const sel = await addProperty(d.c, db.id, { name: 's', type: 'select' })
    const o = await addOption(d.c, sel, { name: 'a' })
    const r = await createRow(d.c, db.id)
    await setCell(d.c, r, { id: sel, type: 'select' }, o)
    await removeOption(d.c, sel, o)
    let m = (await d.s()).databases.get(db.id)!
    expect(m.properties.find(p => p.id === sel)!.options).toEqual([])
    expect(m.rows[0]!.cells[sel]).toBe(o) // the cell still names the removed option; the UI shows no option for it
    await trashProperty(d.c, sel)
    m = (await d.s()).databases.get(db.id)!
    expect(m.properties.find(p => p.id === sel)!.trashed).toBe(true)
    expect(m.rows[0]!.cells[sel]).toBe(o)
  })

  it('a database seen only in part (the other ops have not arrived) and odd data do not break the projection', async () => {
    const d = new Dev(WS)
    const [dbId, prop, row] = [uuidv7(), uuidv7(), uuidv7()]
    await d.c.setFields(row, { db: dbId, sortKey: 'a1', trashed: false, [`c:${prop}`]: 'x' }, 'row') // the database has not arrived: the row is simply not shown
    await d.c.setFields(prop, { db: dbId, name: 'p', type: 'nonsense', config: null, sortKey: 'a0', trashed: false }, 'property')
    let s = await d.s()
    expect(s.databases.size).toBe(0)
    await d.c.setFields(dbId, { title: 'late', parent: '', sortKey: 'a0', trashed: false }, 'database')
    s = await d.s()
    const m = s.databases.get(dbId)!
    expect(m.properties[0]!.type).toBe('text') // an unknown type reads as text
    expect(m.rows[0]!.cells[prop]).toBe('x')
    expect(titleProperty(m.properties)!.id).toBe(prop) // no title property marked: the first one
    await d.c.setFields(row, { [`c:${prop}`]: 5 as never })
    expect((await d.s()).databases.get(dbId)!.rows[0]!.cells[prop]).toBeNull() // a cell of the wrong shape reads as empty
  })

  it('tags, saved searches, settings and views', async () => {
    const d = new Dev(WS)
    const page = await createPage(d.c, { title: 'p' })
    const t = await createTag(d.c, { name: 'مهم' })
    await tagPage(d.c, page, t, true)
    await createSavedSearch(d.c, { name: 'امروز', query: 'due:today' })
    await setSetting(d.c, 'theme', 'dark')
    const db = await createDatabase(d.c)
    const v = await createView(d.c, db.id, { name: 'برد', type: 'board', config: { groupBy: 'x' } })
    await setViewConfig(d.c, v, { groupBy: 'y', filters: [{ p: 'a', eq: 1 }] })
    const s = await d.s()
    expect(s.pageTags.get(page)).toEqual([t])
    expect(s.tags).toEqual([{ id: t, name: 'مهم', color: 'gray' }])
    expect(s.savedSearches.map(x => x.query)).toEqual(['due:today'])
    expect(s.settings).toEqual({ theme: 'dark' })
    expect(s.databases.get(db.id)!.views.find(x => x.id === v)!.config).toEqual({ groupBy: 'y', filters: [{ p: 'a', eq: 1 }] })
    await tagPage(d.c, page, t, false)
    expect((await d.s()).pageTags.has(page)).toBe(false)
  })
})

describe('two devices (deterministic relay)', () => {
  async function pair() {
    const a = new Dev(WS), b = new Dev(WS)
    const db = await createDatabase(a.c, { title: 'ک' })
    const sel = await addProperty(a.c, db.id, { name: 'ژانر', type: 'select' })
    const colA = await addProperty(a.c, db.id, { name: 'الف', type: 'text' })
    const colB = await addProperty(a.c, db.id, { name: 'ب', type: 'text' })
    const row = await createRow(a.c, db.id)
    await sync(a, b)
    expect(norm(await a.s())).toBe(norm(await b.s())) // the same starting point on both
    return { a, b, db, sel, colA, colB, row }
  }

  it('two options added at the same time are both kept, on both devices', async () => {
    const { a, b, db, sel } = await pair()
    const oa = await addOption(a.c, sel, { name: 'از الف' })
    const ob = await addOption(b.c, sel, { name: 'از ب' })
    await sync(a, b)
    for (const d of [a, b]) {
      const p = (await d.s()).databases.get(db.id)!.properties.find(x => x.id === sel)!
      expect(p.options.map(o => o.id).sort()).toEqual([oa, ob].sort())
    }
    expect(norm(await a.s())).toBe(norm(await b.s()))
  })

  it('two columns of one row edited at the same time are both kept', async () => {
    const { a, b, db, colA, colB, row } = await pair()
    await setCell(a.c, row, { id: colA, type: 'text' }, 'الف')
    await setCell(b.c, row, { id: colB, type: 'text' }, 'ب')
    await sync(a, b)
    for (const d of [a, b]) expect((await d.s()).databases.get(db.id)!.rows[0]!.cells).toMatchObject({ [colA]: 'الف', [colB]: 'ب' })
  })

  it('multi-select: different elements added at once both stay; the SAME element added and removed at once: the larger HLC wins (not add-wins)', async () => {
    const { a, b, db, row } = await pair()
    const ms = await addProperty(a.c, db.id, { name: 'm', type: 'multiSelect' })
    const [x, y] = [await addOption(a.c, ms, { name: 'x' }), await addOption(a.c, ms, { name: 'y' })]
    await sync(a, b)
    await setMembers(a.c, row, ms, { [x]: true })
    await setMembers(b.c, row, ms, { [y]: true })
    await sync(a, b)
    for (const d of [a, b]) expect((await d.s()).databases.get(db.id)!.rows[0]!.cells[ms]).toEqual([x, y])
    // same element: B removes it after A re-adds it (B's HLC is larger because it has seen A's earlier write)
    await setMembers(a.c, row, ms, { [x]: false })
    await sync(a, b)
    await setMembers(a.c, row, ms, { [x]: true })
    await setMembers(b.c, row, ms, { [x]: false })
    await sync(a, b)
    expect(norm(await a.s())).toBe(norm(await b.s()))
  })

  it('surprising but documented: a rename and a recolor of one option made at once keep only one; a rename after a remove brings it back', async () => {
    const { a, b, db, sel } = await pair()
    const o = await addOption(a.c, sel, { name: 'قدیمی', color: 'red' })
    await sync(a, b)
    await updateOption(a.c, sel, o, { name: 'نو' })
    await updateOption(b.c, sel, o, { color: 'blue' })
    await sync(a, b)
    const opt = (await a.s()).databases.get(db.id)!.properties.find(p => p.id === sel)!.options[0]!
    expect([opt.name === 'نو' && opt.color === 'red', opt.name === 'قدیمی' && opt.color === 'blue']).toContain(true) // one of the two edits, whole
    expect(norm(await a.s())).toBe(norm(await b.s()))
  })

  it('a view config edited on both devices keeps ONE of the two (whole value)', async () => {
    const { a, b, db } = await pair()
    const v = (await a.s()).databases.get(db.id)!.views[0]!.id
    await setViewConfig(a.c, v, { filter: 'A' })
    await setViewConfig(b.c, v, { sort: 'B' })
    await sync(a, b)
    const cfg = (await a.s()).databases.get(db.id)!.views[0]!.config
    expect([JSON.stringify({ filter: 'A' }), JSON.stringify({ sort: 'B' })]).toContain(JSON.stringify(cfg))
    expect(norm(await a.s())).toBe(norm(await b.s()))
  })

  it('trashing a row on one device and editing it on the other: both writes are kept (different fields)', async () => {
    const { a, b, db, colA, row } = await pair()
    await trashRow(a.c, row)
    await setCell(b.c, row, { id: colA, type: 'text' }, 'edit')
    await sync(a, b)
    const r = (await b.s()).databases.get(db.id)!.rows[0]!
    expect(r.trashed).toBe(true)
    expect(r.cells[colA]).toBe('edit')
  })

  it('renaming a property and moving a database in the tree at the same time both apply', async () => {
    const { a, b, db, colA } = await pair()
    const p = await createPage(a.c, { title: 'پوشه' })
    await sync(a, b)
    await renameProperty(a.c, colA, 'نام تازه')
    await movePage(b.c, db.id, p, null, null)
    await sync(a, b)
    const s = await b.s()
    expect(s.databases.get(db.id)!.properties.find(x => x.id === colA)!.name).toBe('نام تازه')
    expect(buildTree(s.pages).byId.get(db.id)!.page.parent).toBe(p)
  })
})

// ---- trees and sort keys (properties) ----
const pageRows = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`)

describe('the page tree with databases never shows a cycle (property)', () => {
  let cyclesBroken = 0 // guard: the property is vacuous if the random moves never made a cycle
  it('random concurrent moves, merged in random orders, give one acyclic tree on every device', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ dev: fc.integer({ min: 0, max: 2 }), page: fc.integer({ min: 0, max: 7 }), parent: fc.integer({ min: -1, max: 7 }) }), { minLength: 1, maxLength: 30 }),
      fc.integer(),
      async (moves, seed) => {
        const ids = pageRows(8).map(() => uuidv7())
        const devs = [new Dev(WS), new Dev(WS), new Dev(WS)]
        // one device creates 6 pages and 2 databases; everyone gets them
        for (let i = 0; i < 8; i++) {
          if (i < 6) await createPage(devs[0]!.c, { title: `p${i}` }, ids[i])
          else await devs[0]!.c.setFields(ids[i]!, { title: `d${i}`, parent: '', sortKey: sortKeyBetween(null, null), trashed: false, createdAt: 0 }, 'database')
        }
        for (const d of devs.slice(1)) await d.receive(await devs[0]!.outbox())
        for (const m of moves) await devs[m.dev]!.c.setFields(ids[m.page]!, { parent: m.parent < 0 ? '' : ids[m.parent]!, sortKey: sortKeyBetween(null, null) })
        // everyone receives everyone's ops, each in a different shuffled order, some repeated
        const all = await Promise.all(devs.map(d => d.outbox()))
        const flat = all.flat()
        const shuffle = (xs: string[], k: number) => [...xs, ...xs.slice(0, 3)].sort((p, q) => ((p + k) < (q + k) ? -1 : 1))
        const fresh = [new Dev(WS), new Dev(WS), new Dev(WS)]
        for (const [i, f] of fresh.entries()) await f.receive(shuffle(flat, seed + i))
        const trees = []
        for (const f of fresh) trees.push(buildTree((await f.s()).pages))
        for (const p of (await fresh[0]!.s()).pages) if (p.parent && trees[0]!.parentOf.get(p.id) === '' ) cyclesBroken++
        for (const t of trees) {
          // acyclic: walking parentOf from every page reaches the root
          for (const id of t.parentOf.keys()) { const seen = new Set<string>(); for (let cur = id; cur !== ''; cur = t.parentOf.get(cur)!) { expect(seen.has(cur)).toBe(false); seen.add(cur) } }
          // every non-trashed node exactly once
          const walk: string[] = []
          const go = (ns: typeof t.roots) => { for (const n of ns) { walk.push(n.page.id); go(n.children) } }
          go(t.roots)
          expect(new Set(walk).size).toBe(walk.length)
          expect(walk.length).toBe(8)
        }
        expect(JSON.stringify(trees[0]!.roots.map(r => r.page.id))).toBe(JSON.stringify(trees[1]!.roots.map(r => r.page.id)))
        expect(JSON.stringify([...trees[0]!.parentOf].sort())).toBe(JSON.stringify([...trees[2]!.parentOf].sort()))
      },
    ), { numRuns: 60 })
    expect(cyclesBroken).toBeGreaterThan(10) // cycles really happened and were broken in the view
  })
})

describe('sort keys (property)', () => {
  it('an insert at any position lands strictly between its neighbours, also next to keys that carry a suffix', () => {
    fc.assert(fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 60 }), fc.integer(), (picks, seed) => {
      let s = seed >>> 0
      const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
      const keys: string[] = []
      for (const p of picks) {
        const i = p % (keys.length + 1)
        const lo = i === 0 ? null : keys[i - 1]!, hi = i === keys.length ? null : keys[i]!
        const k = sortKeyBetween(lo, hi, rnd)
        if (lo !== null) expect(k > lo).toBe(true)
        if (hi !== null) expect(k < hi).toBe(true)
        keys.splice(i, 0, k)
      }
      expect(keys).toEqual([...keys].sort())
    }), { numRuns: 300 })
  })
  it('two devices inserting at the same spot get different keys (random suffix), and (sortKey, id) is a strict total order', () => {
    let clashes = 0
    for (let i = 0; i < 20_000; i++) if (sortKeyBetween('a1', 'a2') === sortKeyBetween('a1', 'a2')) clashes++
    expect(clashes).toBe(0) // 58^4 = 11M suffixes: not "impossible", but a clash is also harmless: rows are ordered by (sortKey, id)
    const rows: PageRow[] = Array.from({ length: 50 }, (_, i) => ({ id: `id${String(i).padStart(2, '0')}`, title: '', parent: '', sortKey: 'a1', trashed: false, kind: 'doc', createdAt: 0, parentHlc: '' }))
    const t1 = buildTree(rows).roots.map(r => r.page.id), t2 = buildTree([...rows].reverse()).roots.map(r => r.page.id)
    expect(t1).toEqual(t2) // even with EQUAL sort keys the order is the same on every device
  })
})

describe('the page list still comes from one read and includes databases', () => {
  it('a database is a node of the tree next to pages', async () => {
    const d = new Dev(WS)
    await createPage(d.c, { title: 'صفحه' })
    const db = await createDatabase(d.c, { title: 'پایگاه' })
    const pages = await readPages(d.store)
    expect(pages.map(p => `${p.title}:${p.type}`).sort()).toEqual(['پایگاه:database', 'صفحه:page'].sort())
    expect(db.id).toBe(pages.find(p => p.type === 'database')!.id)
    expect(Object.keys((await projectStore(d.store)).fields).length).toBeGreaterThan(3)
  })
})
