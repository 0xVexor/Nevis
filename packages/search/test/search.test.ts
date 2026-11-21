import { describe, expect, it } from 'vitest'
import { SearchIndex } from '../src'

const idx = () => {
  const i = new SearchIndex()
  i.addAll([
    { id: 'a', title: 'برنامهٔ هفته', body: 'من می‌خواهم کتاب بخوانم. سال ۱۴۰۳' },
    { id: 'b', title: 'Notes', body: 'میخواهم بروم. يك روز خوب. year 1403' },
    { id: 'c', title: 'یادداشت', body: 'من می خواهم بنویسم. یک کتاب' },
    { id: 'd', title: 'Other', body: 'nothing relevant here' },
  ])
  return i
}
const ids = (i: SearchIndex, q: string) => i.search(q).map(h => h.id).sort()

describe('SearchIndex', () => {
  it('the demo of M10: the three spellings, the two digit systems, and ي/ی, ك/ک', () => {
    const i = idx()
    for (const q of ['میخواهم', 'می خواهم', 'می‌خواهم']) expect(ids(i, q).length, q).toBeGreaterThan(0)
    expect(ids(i, '۱۴۰۳')).toEqual(['a', 'b'])
    expect(ids(i, '1403')).toEqual(['a', 'b'])
    expect(ids(i, 'يك')).toEqual(ids(i, 'یک'))
    expect(ids(i, 'يك')).toContain('b')
    expect(ids(i, 'كتاب')).toEqual(['a', 'c'])
  })
  it('ZWNJ query finds joined, ZWNJ and spaced writings', () => expect(ids(idx(), 'می‌خواهم')).toEqual(['a', 'b', 'c']))
  it('prefix, title weight, all words required, no match', () => {
    const i = idx()
    expect(ids(i, 'برنا')).toEqual(['a'])
    expect(i.search('notes')[0]!.id).toBe('b')
    expect(ids(i, 'کتاب بنویسم')).toEqual(['c'])
    expect(ids(i, 'zzzz')).toEqual([])
    expect(i.search('')).toEqual([])
  })
  it('replace and remove', () => {
    const i = idx()
    i.set({ id: 'd', title: 'Other', body: 'now about انار' })
    expect(ids(i, 'انار')).toEqual(['d'])
    expect(ids(i, 'nothing')).toEqual([])
    i.remove('d')
    expect(ids(i, 'انار')).toEqual([])
  })
  it('serializes and loads with the same answers; another NORM_VERSION or damage means "rebuild" (null)', () => {
    const i = idx()
    const back = SearchIndex.load(i.serialize())!
    expect(ids(back, 'می‌خواهم')).toEqual(ids(i, 'می‌خواهم'))
    expect(SearchIndex.load(i.serialize().replace('"norm":1', '"norm":2'))).toBeNull()
    expect(SearchIndex.load('{broken')).toBeNull()
  })
})
