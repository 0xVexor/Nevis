import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SV, uuidv7 } from '@nevis/protocol'
import { Client, MemoryStore, cardId, extractCards, foldSchedules, isDue, reviewCard, schedule, type EventRow, type Grade } from '../src'

const ev = (i: number, ent: string, rating: Grade, at: number): EventRow => ({ id: `e${String(i).padStart(4, '0')}`, ent, kind: 'review', hlc: `${String(at).padStart(13, '0')}-0000-d`, body: JSON.stringify({ card: ent, rating, reviewedAt: at, durationMs: 1 }) })

describe('card schedule fold', () => {
  it('does not depend on the order events arrive in (property)', () => {
    fc.assert(fc.property(fc.array(fc.record({ g: fc.constantFrom<Grade>(0, 1, 2, 3), card: fc.constantFrom('A', 'B', 'C') }), { minLength: 1, maxLength: 30 }), fc.integer({ min: 1, max: 1000 }), (xs, seed) => {
      const events = xs.map((x, i) => ev(i, x.card, x.g, 1_700_000_000_000 + i * 3_600_000))
      const shuffled = [...events].sort((a, b) => ((a.id.charCodeAt(2) * seed) % 7) - ((b.id.charCodeAt(2) * seed) % 7) || (a.id < b.id ? 1 : -1))
      expect([...foldSchedules(shuffled)].sort()).toEqual([...foldSchedules(events)].sort())
    }))
  })
  it('two reviews of one card on two devices at the same moment are both kept and fold to one schedule', () => {
    const a = ev(1, 'A', 2, 1_700_000_000_000), b = { ...ev(2, 'A', 3, 1_700_000_000_000), hlc: a.hlc.replace('-d', '-e') }
    const one = foldSchedules([a, b]).get('A')!, two = foldSchedules([b, a]).get('A')!
    expect(one).toEqual(two)
    expect(one.reps).toBe(2) // both reviews counted
  })
  it('matches the old scheduler: good, good, good = 1, 3, then ease x interval days', () => {
    let r = schedule(undefined, 2, 0); expect(r.interval).toBe(1)
    r = schedule(r, 2, 0); expect(r.interval).toBe(3)
    r = schedule(r, 2, 0); expect(r.interval).toBe(Math.round(3 * 2.5))
    expect(schedule(r, 0, 5).interval).toBe(0)
    expect(isDue(undefined, 0)).toBe(true)
  })
  it('a review written through the client is an event about the card, and folds', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws: uuidv7(), device: uuidv7(), sv: SV })
    const id = cardId('page-1', 'پایتخت ایران؟')
    await reviewCard(c, id, 2, 1_700_000_000_000)
    const events = await store.run(tx => tx.allEvents())
    expect(foldSchedules(events).get(id)!.reps).toBe(1)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('extractCards', () => {
  const doc = { type: 'doc', content: [
    { type: 'toggle', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'پایتخت ایران؟' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'تهران' }] }] },
    { type: 'toggle', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'بدون پاسخ' }] }, { type: 'paragraph' }] },
    { type: 'toggle', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'پایتخت ایران؟' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'دوباره' }] }] },
  ] }
  it('toggles with a question and an answer; the same question twice is one card; the id ignores letter variants', () => {
    const cards = extractCards('p', doc)
    expect(cards.length).toBe(1)
    expect(cards[0]!.answer).toBe('تهران')
    expect(cardId('p', 'پایتخت ایران؟')).toBe(cardId('p', 'پایتخت ايران؟'))
    expect(cardId('p', 'a')).not.toBe(cardId('q', 'a'))
  })
})
