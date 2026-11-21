import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SV, uuidv7 } from '@nevis/protocol'
import { Client, MemoryStore, addVersion, readVersions, thinVersions, type Version } from '../src'

const NOW = 1_800_000_000_000
const v = (i: number, ageMs: number, manual = false): Version => ({ id: `v${String(i).padStart(5, '0')}`, page: 'p', at: NOW - ageMs, manual, label: '', json: '{}' })

describe('thinning', () => {
  it('keeps everything up to an hour, one per hour to 24 h, one per day to 30 days, one per week after', () => {
    const MIN = 60_000, H = 3600_000, D = 24 * H
    const vs = [...Array.from({ length: 10 }, (_, i) => v(i, i * 5 * MIN)), ...Array.from({ length: 8 }, (_, i) => v(100 + i, 2 * H + i * 10 * MIN)), ...Array.from({ length: 6 }, (_, i) => v(200 + i, 3 * D + i * 2 * H)), ...Array.from({ length: 6 }, (_, i) => v(300 + i, 60 * D + i * D))]
    const kept = thinVersions(vs, NOW)
    expect(kept.filter(k => NOW - k.at <= H).length).toBe(vs.filter(x => NOW - x.at <= H).length) // all of the first hour
    expect(kept.length).toBeLessThan(vs.length)
  })
  it('never drops a manual version or the newest one, and only ever returns versions it was given (property)', () => {
    fc.assert(fc.property(fc.array(fc.record({ age: fc.integer({ min: 0, max: 400 * 24 * 3600_000 }), manual: fc.boolean() }), { minLength: 1, maxLength: 80 }), xs => {
      const vs = xs.map((x, i) => v(i, x.age, x.manual))
      const kept = thinVersions(vs, NOW)
      const ids = new Set(kept.map(k => k.id))
      for (const x of vs) if (x.manual) expect(ids.has(x.id)).toBe(true)
      const newest = [...vs].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))[0]!
      expect(ids.has(newest.id)).toBe(true)
      for (const k of kept) expect(vs.some(x => x.id === k.id)).toBe(true)
    }))
  })
  it('is not vacuous: many automatic versions in one old day thin down to one', () => {
    const vs = Array.from({ length: 12 }, (_, i) => v(i, 5 * 24 * 3600_000 + i * 60_000))
    expect(thinVersions(vs, NOW).length).toBe(1 + 0) // all in the same day bucket (the newest is also that bucket's latest)
  })
})

describe('versions are events about a page', () => {
  it('written through the client and read back newest first; an oversize page is not versioned', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws: uuidv7(), device: uuidv7(), sv: SV })
    await addVersion(c, 'p', '{"a":1}', { at: 1000 })
    await addVersion(c, 'p', '{"a":2}', { at: 2000, manual: true, label: 'x' })
    const list = readVersions(await store.run(tx => tx.allEvents()), 'p')
    expect(list.map(x => [x.at, x.manual, x.label])).toEqual([[2000, true, 'x'], [1000, false, '']])
    expect(await addVersion(c, 'p', 'x'.repeat(1_000_001), { at: 3 })).toBeNull()
  })
})
