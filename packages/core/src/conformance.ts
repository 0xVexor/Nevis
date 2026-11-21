// The conformance suite every `Store` adapter must pass (ADR-0001 §2): same semantics on memory, IndexedDB and SQLite.
// Import it from a test file: `runStoreConformance('name', () => new MyStore())`.
import { sha256Hex, type BlobStore } from './blobs'
import type { Store } from './store'

/** The few test-framework pieces the suite needs, so it runs under vitest AND in a plain browser page. */
export interface Matchers {
  toBe(v: unknown): void
  toEqual(v: unknown): void
  toBeUndefined(): void
  not: { toBe(v: unknown): void }
  rejects: { toThrow(m?: string): Promise<void> }
}
export interface Harness {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => Promise<void>): void
  expect(actual: unknown): Matchers
}

const enc = (s: string) => new TextEncoder().encode(s)

export function storeConformance({ describe, it, expect }: Harness, name: string, factory: () => Store | Promise<Store>) {
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
      await s.run(tx => tx.putFieldIfNewer('e2', 'f', '2', 'h1'))
      const all = (await s.run(tx => tx.allFields())).map(r => `${r.ent}/${r.f}=${r.val}@${r.hlc}`).sort()
      expect(all).toEqual(['e/f="c"@h3', 'e/g=1@h1', 'e2/f=2@h1'])
    })

    it('rekey: a register or an event moves to a new HLC only from the HLC it holds', async () => {
      const s = await factory()
      await s.run(tx => tx.putFieldIfNewer('e', 'f', '"v"', 'h9'))
      expect(await s.run(tx => tx.rekeyField('e', 'f', 'h8', 'h2'))).toBe(false)
      expect(await s.run(tx => tx.rekeyField('e', 'f', 'h9', 'h2'))).toBe(true)
      expect(await s.run(tx => tx.getField('e', 'f'))).toEqual({ val: '"v"', hlc: 'h2' })
      expect(await s.run(tx => tx.rekeyField('e', 'nope', 'h9', 'h2'))).toBe(false)
      await s.run(tx => tx.putEvent({ id: 'x', ent: 'c', kind: 'review', hlc: 'h9', body: '{}' }))
      expect(await s.run(tx => tx.rekeyEvent('x', 'h3'))).toBe(true)
      expect(await s.run(tx => tx.rekeyEvent('nope', 'h3'))).toBe(false)
      expect((await s.run(tx => tx.allEvents()))[0]!.hlc).toBe('h3')
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

    it('outbox: the attachments an op waits for (the gate) come back as written, and a row without any has none', async () => {
      const s = await factory()
      const h = 'a'.repeat(64)
      await s.run(async tx => { await tx.addOutbox({ op: 'g', env: 'G', created: 1, blobs: [h, 'b'.repeat(64)] }); await tx.addOutbox({ op: 'n', env: 'N', created: 2 }) })
      const rows = await s.run(tx => tx.listOutbox(10))
      expect(rows.map(r => [r.op, r.blobs ?? []])).toEqual([['g', [h, 'b'.repeat(64)]], ['n', []]])
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
      // only Tx calls are awaited inside: a real IndexedDB transaction ends as soon as it awaits anything else
      await Promise.all(Array.from({ length: 20 }, () => s.run(async tx => {
        const n = Number(await tx.getMeta('n'))
        await tx.getMeta('pad')
        await tx.setMeta('n', String(n + 1))
      })))
      expect(await s.run(tx => tx.getMeta('n'))).toBe('20')
    })
  })
}

/** The conformance suite every `BlobStore` adapter must pass (memory, IndexedDB, the desktop's files + SQLite). The bytes given to `put`
 *  always match their hash: the desktop adapter checks it (a name means its content) and refuses anything else. */
export function blobStoreConformance({ describe, it, expect }: Harness, name: string, factory: () => BlobStore | Promise<BlobStore>) {
  const read = async (b: Blob | undefined) => (b ? new Uint8Array(await b.arrayBuffer()) : undefined)
  const data = (n: number, seed: number) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255; return a }
  const file = async (n: number, seed: number) => { const bytes = data(n, seed); return { bytes, blob: new Blob([bytes]), hash: await sha256Hex(bytes) } }
  const absent = '2'.repeat(64)
  describe(`BlobStore conformance: ${name}`, () => {
    it('put keeps bytes and a row (not yet on the server); the same hash again changes nothing', async () => {
      const s = await factory()
      const f = await file(1000, 1)
      const m = await s.put(f.hash, f.blob, 'image/png')
      expect([m.hash, m.size, m.mime, m.remote, m.failed]).toEqual([f.hash, 1000, 'image/png', false, ''])
      expect(await read(await s.get(f.hash))).toEqual(f.bytes)
      await s.setRemote(f.hash, true)
      const again = await s.put(f.hash, f.blob, 'text/plain') // a second put of a stored hash is ignored, remote stays true
      expect([again.size, again.mime, again.remote]).toEqual([1000, 'image/png', true])
      expect((await s.meta(f.hash))!.remote).toBe(true)
      expect(await s.meta(absent)).toBeUndefined()
      expect(await s.get(absent)).toBeUndefined()
    })
    it('a blob of 3 MB comes back byte for byte (the bytes are not changed by the adapter)', async () => {
      const s = await factory()
      const f = await file(3 << 20, 7)
      await s.put(f.hash, f.blob, 'application/octet-stream')
      const back = await read(await s.get(f.hash))
      expect(back!.length).toBe(3 << 20)
      expect(back![12345]).toBe(f.bytes[12345]!)
      expect(back![(3 << 20) - 1]).toBe(f.bytes[(3 << 20) - 1]!)
      expect(await sha256Hex(back!)).toBe(f.hash)
    })
    it('pending lists, oldest first, only what is neither on the server nor failed; putRemote stores a downloaded file as remote', async () => {
      const s = await factory()
      const [a, b, c, d] = [await file(10, 1), await file(11, 2), await file(12, 3), await file(13, 4)]
      await s.put(a!.hash, a!.blob, ''); await s.put(b!.hash, b!.blob, ''); await s.put(c!.hash, c!.blob, '')
      await s.putRemote(d!.hash, d!.blob, 'image/gif')
      expect((await s.pending()).map(m => m.hash)).toEqual([a!.hash, b!.hash, c!.hash])
      await s.setRemote(a!.hash, true)
      await s.setFailed(b!.hash, 'blob_too_large')
      expect((await s.pending()).map(m => m.hash)).toEqual([c!.hash])
      await s.setRemote(a!.hash, false) // collected on the server
      expect((await s.pending()).map(m => m.hash)).toEqual([a!.hash, c!.hash])
      expect((await s.meta(b!.hash))!.failed).toBe('blob_too_large')
      expect((await s.meta(d!.hash))!.remote).toBe(true)
      expect((await s.all()).length).toBe(4)
    })
    it('delete removes the bytes and the row', async () => {
      const s = await factory()
      const f = await file(5, 9)
      await s.put(f.hash, f.blob, '')
      await s.delete(f.hash)
      expect(await s.meta(f.hash)).toBeUndefined()
      expect(await s.get(f.hash)).toBeUndefined()
      await s.delete(f.hash) // twice is fine
    })
  })
}
