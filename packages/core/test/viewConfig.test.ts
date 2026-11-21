import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@nevis/protocol'
import {
  Client, MemoryStore, addOption, addProperty, boardColumns, createDatabase, createRow, moveCard, patchViewConfig, readStructured, readViewConfig, setCell, viewRows, type PropertyModel, type RowModel,
} from '../src'

const prop = (id: string, type: PropertyModel['type'], options: PropertyModel['options'] = []): PropertyModel => ({ id, db: 'd', name: id, type, config: {}, sortKey: id, trashed: false, isTitle: false, options })
const row = (id: string, cells: RowModel['cells'], sortKey = id): RowModel => ({ id, db: 'd', sortKey, trashed: false, createdAt: 0, cells, title: '' })

describe('view config: versioned and tolerant', () => {
  const props = [prop('t', 'text'), prop('s', 'select', [{ id: 'o1', name: 'الف', color: 'red', sortKey: 'a' }]), prop('n', 'number')]
  it('anything unreadable is the default; nothing throws', () => {
    for (const raw of [undefined, null, 5, 'x', [], true, { sort: 3 }, { groupBy: 7, hidden: 'x', sort: [1, null, {}] }]) expect(readViewConfig(raw as never, props)).toEqual({ v: 1, groupBy: '', sort: [], hidden: [], filter: [] })
  })
  it('a groupBy that is gone, trashed or not a select is "no grouping"; sort and hidden drop what no longer exists', () => {
    const cfg = readViewConfig({ v: 1, groupBy: 'n', sort: [{ prop: 'n', dir: 'desc' }, { prop: 'gone', dir: 'asc' }, { prop: 't', dir: 'sideways' }], hidden: ['t', 'gone', 5] }, props)
    expect(cfg).toEqual({ v: 1, groupBy: '', sort: [{ prop: 'n', dir: 'desc' }, { prop: 't', dir: 'asc' }], hidden: ['t'], filter: [] })
    expect(readViewConfig({ groupBy: 's' }, props).groupBy).toBe('s')
    expect(readViewConfig({ groupBy: 's' }, [{ ...props[1]!, trashed: true }]).groupBy).toBe('')
  })
  it('a newer build\'s fields survive a rewrite by this one, and `v` never goes down', () => {
    const next = patchViewConfig({ v: 3, groupBy: 's', future: { x: [1, 2] }, cardCover: 'img' }, { sort: [{ prop: 'n', dir: 'asc' }] }) as Record<string, unknown>
    expect(next.future).toEqual({ x: [1, 2] })
    expect(next.cardCover).toBe('img')
    expect(next.v).toBe(3)
    expect(next.groupBy).toBe('s')
    expect(next.sort).toEqual([{ prop: 'n', dir: 'asc' }])
    expect((patchViewConfig(undefined, { groupBy: 's' }) as Record<string, unknown>).v).toBe(1)
  })
})

describe('what a view shows', () => {
  const props = [prop('t', 'text'), prop('n', 'number'), prop('s', 'select', [{ id: 'o1', name: 'یک', color: '', sortKey: 'a' }, { id: 'o2', name: 'دو', color: '', sortKey: 'b' }]), prop('c', 'checkbox')]
  const rows = [row('r1', { t: 'ب', n: '10', s: 'o2', c: true }), row('r2', { t: 'الف', n: '9.5', s: 'o1', c: false }), row('r3', { t: null, n: null, s: null, c: false }), row('r4', { t: 'پ', n: '-2', s: 'gone', c: true })]
  const cfg = (over: Partial<ReturnType<typeof readViewConfig>> = {}) => ({ v: 1, groupBy: '', sort: [], hidden: [], filter: [], ...over })
  it('sorts numbers exactly, text in Persian order, selects by option order, checkboxes false before true; empty last; desc reverses', () => {
    const ids = (c: ReturnType<typeof cfg>) => viewRows(rows, props, c).map(r => r.id)
    expect(ids(cfg({ sort: [{ prop: 'n', dir: 'asc' }] }))).toEqual(['r4', 'r2', 'r1', 'r3'])
    expect(ids(cfg({ sort: [{ prop: 'n', dir: 'desc' }] }))).toEqual(['r1', 'r2', 'r4', 'r3'])
    expect(ids(cfg({ sort: [{ prop: 't', dir: 'asc' }] }))).toEqual(['r2', 'r1', 'r4', 'r3'])
    expect(ids(cfg({ sort: [{ prop: 's', dir: 'asc' }] }))).toEqual(['r2', 'r1', 'r4', 'r3']) // r4 holds a removed option: it ranks after the real ones
    expect(ids(cfg({ sort: [{ prop: 'c', dir: 'asc' }, { prop: 'n', dir: 'asc' }] }))).toEqual(['r2', 'r3', 'r4', 'r1'])
  })
  it('a sort is a permutation that keeps the rows\' own order for equal keys, and trashed rows are left out (property)', () => {
    fc.assert(fc.property(fc.array(fc.record({ n: fc.option(fc.integer({ min: -5, max: 5 }).map(String), { nil: null }) }), { maxLength: 30 }), list => {
      const rs = list.map((c, i) => row('r' + String(i).padStart(3, '0'), { n: c.n }))
      rs.push({ ...row('zz', { n: '0' }), trashed: true })
      const out = viewRows(rs, props, cfg({ sort: [{ prop: 'n', dir: 'asc' }] }))
      expect(out.length).toBe(list.length)
      expect(new Set(out.map(r => r.id)).size).toBe(list.length)
      for (let i = 1; i < out.length; i++) { const [a, b] = [out[i - 1]!, out[i]!]; if (a.cells.n === b.cells.n) expect(a.id < b.id).toBe(true) }
    }))
  })
  it('a board has one column per option, in option order, and a no-value column for empty or removed options', () => {
    const cols = boardColumns(rows, props, cfg({ groupBy: 's' }))
    expect(cols.map(c => [c.id, c.rows.map(r => r.id)])).toEqual([['', ['r3', 'r4']], ['o1', ['r2']], ['o2', ['r1']]])
    expect(boardColumns(rows, props, cfg()).length).toBe(1) // no grouping: one column with everything
  })
})

describe('moving a card is ONE op', () => {
  it('the option and the position are written together; the row shows in the new column', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws: uuidv7(), device: uuidv7(), sv: 2 })
    const db = await createDatabase(c, { title: 'ب' })
    const sel = await addProperty(c, db.id, { name: 'وضعیت', type: 'select' })
    const [a, b] = [await addOption(c, sel, { name: 'الف' }), await addOption(c, sel, { name: 'ب' })]
    const r = await createRow(c, db.id)
    await setCell(c, r, { id: sel, type: 'select' }, a)
    const before = (await store.run(tx => tx.listOutbox(1000))).length
    await moveCard(c, r, sel, b, null, null)
    expect((await store.run(tx => tx.listOutbox(1000))).length).toBe(before + 1)
    const m = (await readStructured(store)).databases.get(db.id)!
    const cols = boardColumns(m.rows, m.properties, { v: 1, groupBy: sel, sort: [], hidden: [], filter: [] })
    expect(cols.find(x => x.id === b)!.rows.map(x => x.id)).toEqual([r])
    expect(cols.find(x => x.id === a)!.rows).toEqual([])
    await moveCard(c, r, sel, '', null, null) // back to "no value"
    expect(boardColumns((await readStructured(store)).databases.get(db.id)!.rows, m.properties, { v: 1, groupBy: sel, sort: [], hidden: [], filter: [] })[0]!.rows.map(x => x.id)).toEqual([r])
  })
})

describe('filter', () => {
  const props = [
    { id: 'n', name: 'نام', type: 'text', options: [], trashed: false, isTitle: true },
    { id: 'p', name: 'قیمت', type: 'number', options: [], trashed: false, isTitle: false },
    { id: 's', name: 'وضعیت', type: 'select', options: [{ id: 'o1', name: 'تمام', color: '', sortKey: 'a' }], trashed: false, isTitle: false },
  ] as never[]
  const row = (id: string, cells: Record<string, unknown>) => ({ id, db: 'd', sortKey: id, trashed: false, createdAt: 0, cells, title: '' }) as never
  const rows = [row('1', { n: 'کتاب', p: '10', s: 'o1' }), row('2', { n: 'قلم', p: '25' }), row('3', { n: 'کتابچه', p: '7' })]
  const run = (filter: unknown[]) => viewRows(rows, props, readViewConfig({ v: 1, filter } as never, props)).map(r => r.id)
  it('every rule must hold; text contains, numbers compare exactly, select and empty work', () => {
    expect(run([{ prop: 'n', op: 'contains', value: 'کتاب' }])).toEqual(['1', '3'])
    expect(run([{ prop: 'n', op: 'contains', value: 'کتاب' }, { prop: 'p', op: 'gt', value: '8' }])).toEqual(['1'])
    expect(run([{ prop: 's', op: 'is', value: 'o1' }])).toEqual(['1'])
    expect(run([{ prop: 's', op: 'empty', value: '' }])).toEqual(['2', '3'])
    expect(run([{ prop: 'p', op: 'lt', value: '10' }])).toEqual(['3'])
  })
  it('a rule on a property that is gone, or with an unknown operator, is ignored when the config is read; unknown fields survive a patch', () => {
    expect(run([{ prop: 'gone', op: 'is', value: 'x' }, { prop: 'n', op: 'nope', value: 'x' }])).toEqual(['1', '2', '3'])
    const kept = patchViewConfig({ v: 1, future: 5 } as never, { filter: [{ prop: 'n', op: 'is', value: 'x' }] }) as { future: number; filter: unknown[] }
    expect(kept.future).toBe(5); expect(kept.filter).toHaveLength(1)
  })
})
