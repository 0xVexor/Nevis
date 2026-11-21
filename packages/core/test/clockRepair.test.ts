import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MAX_SKEW_MS, b64urlDecode, decodeFrame, decodeRec, parseEnvelope, parseHlc, uuidv7, SV } from '@nevis/protocol'
import { Client, MemoryStore, NetError, SyncEngine, projectStore, type Net, type PullResult, type PushResult } from '../src'

/** A tiny log server that refuses a batch with an HLC too far ahead of ITS clock, exactly like the Go server. */
class SkewedServer implements Net {
  log: { seq: number; env: string }[] = []
  refusals = 0
  private readonly clock: () => number
  constructor(clock: () => number) { this.clock = clock }
  async push(_ws: string, envs: string[]): Promise<PushResult> {
    if (envs.some(e => parseHlc(parseEnvelope(e).t)!.ms > this.clock() + MAX_SKEW_MS)) { this.refusals++; throw new NetError(422, 'clock_ahead', false) }
    const results = envs.map(env => {
      const op = parseEnvelope(env).op
      const seen = this.log.find(l => parseEnvelope(l.env).op === op)
      if (seen) return { op, seq: seen.seq, status: 'dup' as const }
      this.log.push({ seq: this.log.length + 1, env })
      return { op, seq: this.log.length, status: 'ok' as const }
    })
    return { results, head: this.log.length }
  }
  async pull(_ws: string, after: number): Promise<PullResult> {
    return { ops: this.log.filter(l => l.seq > after).map(l => ({ seq: l.seq, by: 'x', rt: 0, env: l.env })), head: this.log.length, more: false }
  }
}

const HOUR = 3_600_000
const WS = uuidv7()

describe('a device whose clock ran ahead', () => {
  it('loses nothing: the batch is refused, the ops wait, and once the clock is right they are rebuilt and sent', async () => {
    const real = 1_800_000_000_000
    let deviceNow = real + 2 * HOUR // two hours fast
    const server = new SkewedServer(() => real)
    const store = new MemoryStore()
    const device = uuidv7()
    const client = new Client({ store, ws: WS, device, sv: SV, now: () => deviceNow })
    const engine = new SyncEngine({ store, net: server, ws: WS, device, sv: SV, now: () => deviceNow })

    const ent = uuidv7(), doc = uuidv7(), card = uuidv7()
    const o1 = await client.setFields(ent, { title: 'می‌خواهم', n: 7 }, 'page')
    const y = new Y.Doc(); const ups: Uint8Array[] = []; y.on('update', u => ups.push(u))
    y.getXmlFragment('body').insert(0, [new Y.XmlElement('paragraph')])
    const o2 = await client.writeYUpdate(doc, ups[0]!)
    const o3 = await client.addEvent(card, 'review', { rating: 3 })
    const before = (await store.run(tx => tx.listOutbox(10))).map(r => r.op)
    expect(before).toEqual([o1, o2, o3])

    // refused, loud, nothing lost
    await expect(engine.cycle()).rejects.toMatchObject({ code: 'clock_ahead' })
    await expect(engine.cycle()).rejects.toMatchObject({ code: 'clock_ahead' }) // still ahead: still refused, still kept
    expect(server.log.length).toBe(0)
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(3)
    expect(await store.run(tx => tx.getMeta('clockAhead'))).toBe('1')
    const oldH = (await store.run(tx => tx.getField(ent, 'title')))!.hlc
    expect(parseHlc(oldH)!.ms).toBeGreaterThan(real + HOUR)

    // the person fixes the clock
    deviceNow = real
    await engine.cycle()
    expect(server.log.length).toBe(3)
    const sent = server.log.map(l => parseEnvelope(l.env))
    for (const e of sent) expect(parseHlc(e.t)!.ms).toBeLessThanOrEqual(real + 1000)
    expect(sent.map(e => e.op).filter(op => [o1, o2, o3].includes(op))).toEqual([]) // new op ids: the old ones never left the device
    expect(new Set(sent.map(e => e.doc))).toEqual(new Set([ent, doc, card])) // the same three things

    // the content is the same, the HLC inside the payload is the new one, and the local registers moved with it
    const rec = decodeRec(decodeFrame(b64urlDecode(sent.find(e => e.doc === ent)!.p)).data)
    expect(rec.set).toEqual({ title: 'می‌خواهم', n: 7 })
    expect(rec.h).toBe(sent.find(e => e.doc === ent)!.t)
    const f = await store.run(tx => tx.entityFields(ent))
    expect(f.title!.hlc).toBe(rec.h)
    expect(f.$kind!.hlc).toBe(rec.h)
    expect((await store.run(tx => tx.allEvents()))[0]!.hlc).toBe(sent.find(e => e.doc === card)!.t)
    expect(await store.run(tx => tx.getMeta('clockAhead'))).toBe('0')
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(0)

    // a second device that reads the log sees exactly what the first one shows
    const other = new MemoryStore()
    await new SyncEngine({ store: other, net: server, ws: WS, device: uuidv7(), sv: SV, now: () => real }).cycle()
    expect(await projectStore(other)).toEqual(await projectStore(store))

    // a later edit on the repaired device still wins over what it wrote before (the clock never goes backwards from here)
    deviceNow = real + 5
    await client.setFields(ent, { title: 'تازه' })
    expect(parseHlc((await store.run(tx => tx.getField(ent, 'title')))!.hlc)!.ms).toBeGreaterThanOrEqual(real)
  })

  it('a write made while the clock was ahead does not beat what other devices wrote since, once repaired', async () => {
    const real = 1_800_000_000_000
    let deviceNow = real + 2 * HOUR
    const server = new SkewedServer(() => real)
    const a = new MemoryStore(), b = new MemoryStore()
    const [da, db] = [uuidv7(), uuidv7()]
    const ca = new Client({ store: a, ws: WS, device: da, sv: SV, now: () => deviceNow }), cb = new Client({ store: b, ws: WS, device: db, sv: SV, now: () => real })
    const ea = new SyncEngine({ store: a, net: server, ws: WS, device: da, sv: SV, now: () => deviceNow }), eb = new SyncEngine({ store: b, net: server, ws: WS, device: db, sv: SV, now: () => real })
    const ent = uuidv7()
    await ca.setFields(ent, { title: 'from the fast clock' }, 'page') // HLC two hours ahead
    await expect(ea.cycle()).rejects.toMatchObject({ code: 'clock_ahead' })
    await cb.setFields(ent, { title: 'written later by a correct clock' }, 'page')
    await eb.cycle()
    await expect(ea.cycle()).rejects.toMatchObject({ code: 'clock_ahead' }) // pulling is fine, pushing is refused
    // on the fast device the future-HLC register still beats the remote write: that is the divergence the repair exists to end
    expect((await projectStore(a)).fields[ent]!.title).toBe('from the fast clock')
    deviceNow = real + 10 // the clock is fixed
    await ea.cycle(); await eb.cycle(); await ea.cycle()
    const [pa, pb] = [await projectStore(a), await projectStore(b)]
    expect(pa).toEqual(pb)
    // both agree. The repaired write is stamped at the repair time (real + 10 ms), later than b's, so by HLC order it wins everywhere
    expect(pa.fields[ent]!.title).toBe('from the fast clock')
  })
})
