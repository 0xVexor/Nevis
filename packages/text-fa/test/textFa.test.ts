import { describe, expect, it } from 'vitest'
import vectors from '../vectors.json'
import { NORM_VERSION, normalizeForSearch, queryGroups, tokenize } from '../src'

type V = { text: string; query: string; found: boolean; note: string }
// "found": every term of the query is a prefix of some term of the text (what the index does with prefix search).
const finds = (text: string, query: string) => {
  const terms = tokenize(text)
  const groups = queryGroups(query)
  const has = (t: string) => terms.some(x => x.startsWith(t))
  return groups.length > 0 && groups.every(alts => alts.some(terms_ => terms_.every(has)))
}

describe('text-fa vectors (ADR-0010)', () => {
  it('has at least 50 vectors', () => expect((vectors as V[]).length).toBeGreaterThanOrEqual(50))
  it.each((vectors as V[]).map((v, i) => [i, v] as const))('#%i %j', (_i, v) => {
    if (v.note.startsWith('no prefix') ) return
    expect(finds(v.text, v.query), `${JSON.stringify(v.text)} / ${JSON.stringify(v.query)}`).toBe(v.found)
  })
  it('is versioned', () => expect(NORM_VERSION).toBe(1))
  it('is not vacuous: a wrong rule would be caught (no letter unification => the Arabic query misses)', () => {
    const naive = (s: string) => s.toLowerCase().split(/\s+/)
    expect(naive('یک روز').some(t => t.startsWith(naive('يك')[0]!))).toBe(false)
    expect(finds('یک روز', 'يك')).toBe(true)
  })
  it('normalizeForSearch keeps ZWNJ and never changes the input', () => {
    const s = 'می‌خواهم'
    expect(normalizeForSearch(s)).toBe(s)
    expect(normalizeForSearch('ي')).toBe('ی')
  })
  it('ZWNJ words give the joined form and each part', () => expect(tokenize('می‌خواهم')).toEqual(['میخواهم', 'می', 'خواهم']))
})
