// The conformance suite every `Store` adapter must pass (ADR-0001 §2): same semantics on memory, IndexedDB and SQLite.
// Import it from a test file: `runStoreConformance('name', () => new MyStore())`.
import { describe, expect, it } from 'vitest'
import type { Store } from './store'

const enc = (s: string) => new TextEncoder().encode(s)

export function runStoreConformance(name: string, factory: () => Store | Promise<Store>) {
  describe(`Store conformance: ${name}`, () => {
    it('meta: reads what was written, in the same and in a later transaction', async () => {
      const s = await factory()
      await s.run(async tx => { await tx.setMeta('a', '1'); expect(await tx.getMeta('a')).toBe('1') })
      expect(await s.run(tx => tx.getMeta('a'))).toBe('1')
      expect(await s.run(tx => tx.getMeta('missing'))).toBeUndefined()
    })

    it('register: the greater HLC wins, an equal or smaller one is ignored, in any order', async () => {
      const s = await factory()
      expect(await s.run(tx => tx.putFieldIfNewer('e', 'f', '"b"', 'h2'))).toBe(true)
      expect(await s.run(tx => tx.putFieldIfNewer('e', 'f', '"a"', 'h1'))).toBe(false)
      expect(await s.run(tx => tx.putFieldIfNewer('e', 'f', '"x"', 'h2'))).toBe(false)
      expect(await s.run(tx => tx.putFieldIfNewer('e', 'f', '"c"', 'h3'))).toBe(true)
      expect(await s.run(tx => tx.getField('e', 'f'))).toEqual({ val: '"c"', hlc: 'h3' })
      expect(await s.run(tx => tx.getField('e', 'nope'))).toBeUndefined()
      await s.run(tx => tx.putFieldIfNewer('e', 'g', '1', 'h1'))
      expect(Object.keys(await s.run(tx => tx.entityFields('e'))).sort()).toEqual(['f', 'g'])
      expect(await s.run(tx => tx.entities())).toEqual(['e'])
    })

    it('events: inserted once, never changed', async () => {
      const s = await factory()
      const e = { id: 'x', ent: 'card', kind: 'review', hlc: 'h1', body: '{"r":3}' }
      expect(await s.run(tx => tx.putEvent(e))).toBe(true)
      expect(await s.run(tx => tx.putEvent({ ...e, body: '{"r":1}' }))).toBe(false)
      expect(await s.run(tx => tx.allEvents())).toEqual([e])
    })

    it('documents: updates get increasing k, can be deleted through k, state and max sv are kept', async () => {
      const s = await factory()
      const ks = await s.run(async tx => [await tx.appendDocUpdate('d', enc('1')), await tx.appendDocUpdate('d', enc('2')), await tx.appendDocUpdate('d', enc('3'))])
      expect(ks).toEqual([1, 2, 3])
      await s.run(tx => tx.deleteDocUpdates('d', 2))
      const left = await s.run(tx => tx.listDocUpdates('d'))
      expect(left.map(u => u.k)).toEqual([3])
      expect(new TextDecoder().decode(left[0]!.upd)).toBe('3')
      expect(await s.run(tx => tx.appendDocUpdate('d', enc('4')))).toBe(4) // k never goes back
      await s.run(tx => tx.putDocState('d', enc('state'), 1))
      await s.run(tx => tx.bumpMaxSv('d', 3))
      await s.run(tx => tx.bumpMaxSv('d', 2))
      const st = await s.run(tx => tx.getDocState('d'))
      expect(new TextDecoder().decode(st!.state!)).toBe('state')
      expect(st!.maxSv).toBe(3)
      expect(await s.run(tx => tx.docs())).toEqual(['d'])
    })

    it('outbox: in the order added (whatever `created` says), deleted by op id', async () => {
      const s = await factory()
      await s.run(async tx => { await tx.addOutbox({ op: 'b', env: 'B', created: 9 }); await tx.addOutbox({ op: 'a', env: 'A', created: 1 }); await tx.addOutbox({ op: 'c', env: 'C', created: 5 }) })
      expect((await s.run(tx => tx.listOutbox(2))).map(r => r.op)).toEqual(['b', 'a'])
      await s.run(tx => tx.deleteOutbox(['b', 'c', 'zzz']))
      expect((await s.run(tx => tx.listOutbox(10))).map(r => r.op)).toEqual(['a'])
    })

    it('inbox: a seq is inserted once, listed in order after a cursor, deleted by seq', async () => {
      const s = await factory()
      expect(await s.run(tx => tx.putInbox({ seq: 5, env: 'e5' }))).toBe(true)
      expect(await s.run(tx => tx.putInbox({ seq: 5, env: 'again' }))).toBe(false)
      await s.run(async tx => { await tx.putInbox({ seq: 3, env: 'e3' }); await tx.putInbox({ seq: 9, env: 'e9' }) })
      expect((await s.run(tx => tx.listInbox(0, 10))).map(r => r.seq)).toEqual([3, 5, 9])
      expect((await s.run(tx => tx.listInbox(3, 1))).map(r => r.seq)).toEqual([5])
      await s.run(tx => tx.deleteInbox([3, 9]))
      expect((await s.run(tx => tx.listInbox(0, 10))).map(r => r.env)).toEqual(['e5'])
    })

    it('quarantine keeps what could not be applied', async () => {
      const s = await factory()
      await s.run(tx => tx.addQuarantine({ seq: 1, env: 'x', reason: 'bad' }))
      expect(await s.run(tx => tx.listQuarantine())).toEqual([{ seq: 1, env: 'x', reason: 'bad' }])
    })

    it('atomic: a transaction that throws leaves NOTHING behind, in any table', async () => {
      const s = await factory()
      await s.run(tx => tx.setMeta('keep', 'yes'))
      await expect(
        s.run(async tx => {
          await tx.setMeta('keep', 'no')
          await tx.setMeta('new', '1')
          await tx.putFieldIfNewer('e', 'f', '1', 'h1')
          await tx.putEvent({ id: 'x', ent: 'e', kind: 'k', hlc: 'h', body: '{}' })
          await tx.appendDocUpdate('d', enc('u'))
          await tx.putDocState('d', enc('s'), 1)
          await tx.addOutbox({ op: 'o', env: 'E', created: 1 })
          await tx.putInbox({ seq: 1, env: 'E' })
          await tx.addQuarantine({ seq: 1, env: 'E', reason: 'r' })
          throw new Error('crash in the middle')
        }),
      ).rejects.toThrow('crash in the middle')
      expect(await s.run(tx => tx.getMeta('keep'))).toBe('yes')
      expect(await s.run(tx => tx.getMeta('new'))).toBeUndefined()
      expect(await s.run(tx => tx.entities())).toEqual([])
      expect(await s.run(tx => tx.docs())).toEqual([])
      expect(await s.run(tx => tx.listOutbox(10))).toEqual([])
      expect(await s.run(tx => tx.listInbox(0, 10))).toEqual([])
      expect(await s.run(tx => tx.listQuarantine())).toEqual([])
      expect(await s.run(tx => tx.appendDocUpdate('d', enc('u')))).toBe(1) // even the update counter went back
    })

    it('transactions never interleave: 20 concurrent read-modify-writes lose nothing', async () => {
      const s = await factory()
      await s.run(tx => tx.setMeta('n', '0'))
      await Promise.all(Array.from({ length: 20 }, () => s.run(async tx => {
        const n = Number(await tx.getMeta('n'))
        await new Promise(r => setTimeout(r, 1))
        await tx.setMeta('n', String(n + 1))
      })))
      expect(await s.run(tx => tx.getMeta('n'))).toBe('20')
    })
  })
}
