import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { uuidv7, SV } from '@nevis/protocol'
import { Client, MemoryStore, buildTree, createPage, isInside, movePage, readPages, renamePage, restorePage, sortKeyBetween, trashPage, type PageRow } from '../src'

const row = (id: string, parent: string, sortKey: string, parentHlc = '', trashed = false): PageRow => ({ id, title: id, parent, sortKey, trashed, kind: 'doc', createdAt: 0, parentHlc })
const client = () => new Client({ store: new MemoryStore(), ws: uuidv7(), device: uuidv7(), sv: SV })

describe('pages on the store', () => {
  it('create, rename, move, trash and restore are read back by ONE bulk read', async () => {
    const c = client()
    const a = await createPage(c, { title: 'الف' })
    const b = await createPage(c, { title: 'ب', before: null, after: null })
    await renamePage(c, a, 'الف ۲')
    await movePage(c, b, a, null, null)
    await trashPage(c, b)
    let pages = await readPages(c.store)
    expect(pages.map(p => [p.title, p.parent === a ? 'under a' : 'root', p.trashed]).sort()).toEqual([['الف ۲', 'root', false], ['ب', 'under a', true]])
    await restorePage(c, b)
    pages = await readPages(c.store)
    const t = buildTree(pages)
    expect(t.roots.map(n => n.page.title)).toEqual(['الف ۲'])
    expect(t.roots[0]!.children.map(n => n.page.title)).toEqual(['ب'])
  })

  it('a record that is not a page is not listed', async () => {
    const c = client()
    await c.setFields(uuidv7(), { title: 'x' }, 'card')
    expect(await readPages(c.store)).toEqual([])
  })
})

describe('sort keys', () => {
  it('two devices inserting at the same spot get different keys, and a key goes between its neighbours', () => {
    const k1 = sortKeyBetween(null, null), k2 = sortKeyBetween(null, null)
    expect(k1).not.toBe(k2)
    const [lo, hi] = [k1, k2].sort()
    for (let i = 0; i < 200; i++) {
      const m = sortKeyBetween(lo!, hi!)
      expect(m > lo! && m < hi!).toBe(true)
    }
  })
})

describe('the tree', () => {
  it('orders children by (sortKey, id); an unknown parent shows at the root; trash hides the subtree', () => {
    const t = buildTree([row('a', '', 'b'), row('b', '', 'a'), row('c', 'a', 'a'), row('d', 'nope', 'z'), row('e', 'a', 'b', '', true), row('f', 'e', 'a')])
    expect(t.roots.map(n => n.page.id)).toEqual(['b', 'a', 'd'])
    expect(t.byId.get('a')!.children.map(n => n.page.id)).toEqual(['c'])
    expect(t.byId.has('f')).toBe(false)
    expect(t.trash.map(p => p.id)).toEqual(['e'])
  })

  it('a cycle from two merged moves is broken in the view: the LAST move goes to the root', () => {
    const t = buildTree([row('a', 'b', 'a', '0005-a'), row('b', 'a', 'a', '0009-b')])
    expect(t.roots.map(n => n.page.id)).toEqual(['b'])
    expect(t.byId.get('b')!.children.map(n => n.page.id)).toEqual(['a'])
    expect(isInside(t, 'b', 'a')).toBe(true)
    expect(isInside(t, 'a', 'b')).toBe(false)
  })

  it('whatever the parents and the input order: every page appears exactly once, there is no cycle, and the shape does not depend on the order (property)', () => {
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
    const pageArb = fc.array(fc.record({ parent: fc.constantFrom('', ...ids, 'ghost'), key: fc.constantFrom('a', 'b', 'c'), hlc: fc.integer({ min: 0, max: 9999 }), trashed: fc.boolean() }), { minLength: 8, maxLength: 8 })
    fc.assert(fc.property(pageArb, fc.infiniteStream(fc.nat()), (specs, rnd) => {
      const rows = specs.map((s, i) => row(ids[i]!, s.parent, s.key, String(s.hlc).padStart(5, '0') + ids[i], s.trashed))
      const t = buildTree(rows)
      // acyclic: following effective parents always reaches the root
      for (const id of ids) { let cur = id, n = 0; while (cur !== '') { cur = t.parentOf.get(cur)!; if (++n > 20) throw new Error('cycle in ' + id) } }
      const seen: string[] = []
      const walk = (n: typeof t.roots[number]) => { seen.push(n.page.id); n.children.forEach(walk) }
      t.roots.forEach(walk)
      expect(new Set(seen).size).toBe(seen.length)
      // every non-trashed page whose chain has no trashed page is shown
      for (const id of ids) {
        let cur = id, hidden = false
        while (cur !== '') { if (rows.find(r => r.id === cur)!.trashed) hidden = true; cur = t.parentOf.get(cur)! }
        expect(seen.includes(id)).toBe(!hidden)
      }
      const shuffled = [...rows].sort(() => (rnd.next().value % 2 ? 1 : -1))
      expect([...buildTree(shuffled).parentOf].sort()).toEqual([...t.parentOf].sort())
    }), { numRuns: 300 })
  })
})
