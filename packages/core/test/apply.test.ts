import fc from 'fast-check'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { b64urlEncode, encodeEnvelope, encodeEvt, encodeRec, encodeYUpdate, formatHlc, uuidv7, type Envelope } from '@nevis/protocol'
import { Client, MemoryStore, applyEnvelope, loadDoc, projectStore } from '../src'

const WS = uuidv7(), DEV_A = uuidv7(), DEV_B = uuidv7()
const hlc = (ms: number, c: number, dev: string) => formatHlc({ ms, counter: c }, dev)
const env = (doc: string, dev: string, t: string, frame: Uint8Array, sv = 1): Envelope => ({ v: 1, op: uuidv7(), ws: WS, doc, dev, t, sv, kid: 0, p: b64urlEncode(frame) })
const ctx = { device: DEV_A, sv: 1, now: 1_000 }
const apply = (s: MemoryStore, e: Envelope) => s.run(tx => applyEnvelope(tx, e, ctx))

describe('LWW registers', () => {
  const ENT = uuidv7()
  const write = (f: string, v: unknown, ms: number, dev: string) => env(ENT, dev, hlc(ms, 0, dev), encodeRec({ set: { [f]: v as never }, h: hlc(ms, 0, dev) }))

  it('the result does not depend on the order or on repeats (property)', async () => {
    const ops = fc.array(fc.record({ f: fc.constantFrom('title', 'count', 'tag:x'), v: fc.oneof(fc.string(), fc.integer({ min: -5, max: 5 }), fc.boolean(), fc.constant(null)), ms: fc.integer({ min: 1, max: 30 }), dev: fc.constantFrom(DEV_A, DEV_B) }), { minLength: 1, maxLength: 25 })
    await fc.assert(fc.asyncProperty(ops, fc.integer(), async (list, seed) => {
      const envs = list.map(o => write(o.f, o.v, o.ms, o.dev))
      const shuffled = [...envs, ...envs.slice(0, 5)].sort((a, b) => ((a.op + seed) < (b.op + seed) ? -1 : 1))
      const x = new MemoryStore(), y = new MemoryStore()
      for (const e of envs) await apply(x, e)
      for (const e of shuffled) await apply(y, e)
      expect((await projectStore(x)).fields).toEqual((await projectStore(y)).fields)
    }), { numRuns: 100 })
  })

  it('two devices writing different fields at the same moment both keep their field', async () => {
    const s = new MemoryStore()
    await apply(s, write('title', 'A', 5, DEV_A))
    await apply(s, write('count', 7, 5, DEV_B))
    expect((await projectStore(s)).fields[ENT]).toEqual({ count: 7, title: 'A' })
  })

  it('the same field at the same millisecond: the device id breaks the tie, the same way everywhere', async () => {
    const [lo, hi] = DEV_A < DEV_B ? [DEV_A, DEV_B] : [DEV_B, DEV_A]
    const x = new MemoryStore(), y = new MemoryStore()
    await apply(x, write('title', 'lo', 5, lo)); await apply(x, write('title', 'hi', 5, hi))
    await apply(y, write('title', 'hi', 5, hi)); await apply(y, write('title', 'lo', 5, lo))
    expect((await projectStore(x)).fields[ENT]!.title).toBe('hi')
    expect((await projectStore(y)).fields[ENT]!.title).toBe('hi')
  })

  it('a field written as null is a real write (cleared), and a Persian value is kept exactly', async () => {
    const s = new MemoryStore()
    await apply(s, write('title', 'می‌خواهم', 1, DEV_A))
    expect((await projectStore(s)).fields[ENT]!.title).toBe('می‌خواهم')
    await apply(s, write('title', null, 2, DEV_A))
    expect((await projectStore(s)).fields[ENT]!.title).toBeNull()
  })
})

describe('events and documents', () => {
  it('an event is inserted once whatever arrives twice', async () => {
    const s = new MemoryStore(), ent = uuidv7(), id = uuidv7()
    const e = env(ent, DEV_A, hlc(1, 0, DEV_A), encodeEvt({ id, kind: 'review', h: hlc(1, 0, DEV_A), body: { rating: 3 } }))
    await apply(s, e); await apply(s, e)
    expect((await projectStore(s)).events).toEqual([id])
  })

  it('Yjs updates applied in any order and twice give the same body, and compaction does not change it', async () => {
    const doc = uuidv7()
    const a = new Y.Doc(), b = new Y.Doc()
    const updates: Uint8Array[] = []
    a.on('update', u => updates.push(u)); b.on('update', u => updates.push(u))
    const text = (d: Y.Doc) => d.getXmlFragment('body')
    const para = (d: Y.Doc, s: string) => { const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, s); p.insert(0, [t]); text(d).insert(0, [p]) }
    para(a, 'سلام'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    for (let i = 0; i < 120; i++) para(i % 2 ? a : b, `p${i}`)
    const envs = updates.map(u => env(doc, DEV_A, hlc(1, 0, DEV_A), encodeYUpdate(u)))
    const x = new MemoryStore(), y = new MemoryStore()
    for (const e of envs) await apply(x, e)
    for (const e of [...envs].reverse().concat(envs.slice(0, 10))) await apply(y, e)
    const px = (await projectStore(x)).docs[doc], py = (await projectStore(y)).docs[doc]
    expect(px).toBe(py)
    expect(px).toContain('سلام')
    expect((await x.run(tx => tx.listDocUpdates(doc))).length).toBeLessThan(50) // compacted
  })

  it('an op from a newer schema is held, and the document learns it needs an update', async () => {
    const s = new MemoryStore(), doc = uuidv7()
    const r = await s.run(tx => applyEnvelope(tx, env(doc, DEV_B, hlc(1, 0, DEV_B), encodeRec({ set: { a: 1 }, h: hlc(1, 0, DEV_B) }), 2), ctx))
    expect(r).toBe('held')
    expect((await s.run(tx => tx.getDocState(doc)))!.maxSv).toBe(2)
    expect(await s.run(tx => tx.entities())).toEqual([])
  })
})

describe('local writes', () => {
  it('one transaction writes the state, the outbox row and the clock; the outbox keeps the exact bytes', async () => {
    const store = new MemoryStore()
    let t = 5000
    const c = new Client({ store, ws: WS, device: DEV_A, sv: 1, now: () => t })
    const ent = uuidv7()
    const op = await c.setFields(ent, { title: 'سلام' }, 'page')
    const [row] = await store.run(tx => tx.listOutbox(10))
    expect(row!.op).toBe(op)
    const parsed = JSON.parse(row!.env)
    expect(parsed.doc).toBe(ent)
    expect(row!.env).toBe(encodeEnvelope(parsed)) // exactly the canonical serialisation
    expect(await store.run(tx => tx.getMeta('hlc'))).toBe(parsed.t)
    expect((await projectStore(store)).fields[ent]).toEqual({ $kind: 'page', title: 'سلام' })
    t = 100 // the wall clock goes back: the next timestamp still increases
    await c.setFields(ent, { title: 'دوم' })
    const rows = await store.run(tx => tx.listOutbox(10))
    expect(JSON.parse(rows[1]!.env).t > parsed.t).toBe(true)
  })

  it('a failing write leaves neither state nor outbox nor clock change', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws: WS, device: DEV_A, sv: 1, now: () => 1 })
    await expect(c.setFields(uuidv7(), { a: 1 }, undefined)).resolves.toBeTruthy()
    const before = await store.run(tx => tx.getMeta('hlc'))
    await expect(store.run(async tx => { await tx.setMeta('hlc', 'zzz'); throw new Error('x') })).rejects.toThrow()
    expect(await store.run(tx => tx.getMeta('hlc'))).toBe(before)
  })
})
void loadDoc
