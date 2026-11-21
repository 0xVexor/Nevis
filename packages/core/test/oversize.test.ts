import { describe, expect, it } from 'vitest'
import { MAX_P_CHARS, SV, parseEnvelope, uuidv7 } from '@nevis/protocol'
import { Client, DocHandle, MemoryStore, NetError, OpTooLargeError, SyncEngine, type Net, type PushResult } from '../src'
import * as Y from 'yjs'

const ws = uuidv7()

/** A server that refuses (400, permanent) any batch holding an envelope with a `p` over `limit`, like the real one. */
function strictServer(limit: number): Net & { log: string[] } {
  const log: string[] = []
  return {
    log,
    async push(_w, envs): Promise<PushResult> {
      for (const e of envs) if (parseEnvelope(e).p.length > limit) throw new NetError(400, 'bad_envelope', false, 'p too long')
      const results = envs.map(e => { const op = parseEnvelope(e).op; log.push(op); return { op, seq: log.length, status: 'ok' as const } })
      return { results, head: log.length }
    },
    async pull() { return { ops: [], head: log.length, more: false } },
  }
}

describe('an op that can never be accepted must not block the outbox', () => {
  it('the client refuses an op over the size limit and writes NOTHING (the whole local transaction is undone)', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws, device: uuidv7(), sv: SV })
    await c.setFields(uuidv7(), { a: 'fine' }, 'page')
    const before = (await store.run(tx => tx.listOutbox(10))).length
    await expect(c.setFields(uuidv7(), { big: 'x'.repeat(MAX_P_CHARS) }, 'page')).rejects.toBeInstanceOf(OpTooLargeError)
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(before)
    expect((await store.run(tx => tx.entities())).length).toBe(1) // not even the register of the refused op is there
  })

  it('if a bad op got into the outbox anyway (an older client), the good ops around it still reach the server and the bad one is quarantined', async () => {
    const store = new MemoryStore()
    const device = uuidv7()
    const c = new Client({ store, ws, device, sv: SV })
    await c.setFields(uuidv7(), { a: 'before' }, 'page')
    const good2 = await c.setFields(uuidv7(), { a: 'after' }, 'page')
    // an op with a huge p, as an older client without the guard would have queued it
    const bad = parseEnvelope((await store.run(tx => tx.listOutbox(10)))[0]!.env)
    const badEnv = JSON.stringify({ ...bad, op: uuidv7(), p: 'A'.repeat(5000) })
    await store.run(tx => tx.addOutbox({ op: parseEnvelope(badEnv).op, env: badEnv, created: 1 }))
    await c.setFields(uuidv7(), { a: 'last' }, 'page')
    const server = strictServer(1000)
    const s = await new SyncEngine({ store, net: server, ws, device, sv: SV }).cycle()
    expect(s.rejected).toBe(1)
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(0) // nothing stuck
    expect(server.log.length).toBe(3) // before, after, last: everything except the refused op
    expect(server.log).toContain(good2)
    const q = await store.run(tx => tx.listQuarantine())
    expect(q.length).toBe(1)
    expect(q[0]!.seq).toBeLessThan(0)
    expect(q[0]!.reason).toMatch(/bad_envelope/)
  })

  it('a transient failure is still retried (not mistaken for a bad op)', async () => {
    const store = new MemoryStore()
    const device = uuidv7()
    const c = new Client({ store, ws, device, sv: SV })
    await c.setFields(uuidv7(), { a: 1 }, 'page')
    const flaky: Net = { push: async () => { throw new NetError(503, 'unavailable', true) }, pull: async () => ({ ops: [], head: 0, more: false }) }
    await expect(new SyncEngine({ store, net: flaky, ws, device, sv: SV }).cycle()).rejects.toThrow()
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(1)
    expect(await store.run(tx => tx.listQuarantine())).toEqual([])
  })

  it('DocHandle: an edit too large for one op is dropped with a clear signal, not retried for ever', async () => {
    const store = new MemoryStore()
    const client = new Client({ store, ws, device: uuidv7(), sv: SV })
    let tooLarge = 0
    const h = await DocHandle.open({ client, doc: uuidv7(), schedule: () => () => {}, onTooLarge: () => { tooLarge++ } })
    h.ydoc.getText('t').insert(0, 'x'.repeat(MAX_P_CHARS)) // one update bigger than an op may be
    await h.flush()
    expect(tooLarge).toBe(1)
    expect(h.diverged).toBe(true)
    expect(h.unsaved).toBe(0) // dropped: no retry loop
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(0)
  })

  it('after a refused edit NOTHING typed later is saved (it depends on the refused edit): a fresh handle on the same store shows the earlier text only', async () => {
    const store = new MemoryStore()
    const client = new Client({ store, ws, device: uuidv7(), sv: SV })
    const doc = uuidv7()
    const h = await DocHandle.open({ client, doc, schedule: () => () => {} })
    h.ydoc.getText('t').insert(0, 'before ')
    await h.flush()
    h.ydoc.getText('t').insert(h.ydoc.getText('t').length, 'x'.repeat(MAX_P_CHARS)) // refused
    await h.flush()
    expect(h.diverged).toBe(true)
    h.ydoc.getText('t').insert(h.ydoc.getText('t').length, ' LATER') // would depend on the refused edit
    await h.flush()
    expect(h.unsaved).toBe(0)
    const fresh = await DocHandle.open({ client, doc, schedule: () => () => {} })
    expect(fresh.ydoc.getText('t').toString()).toBe('before ')
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(1) // only the first, good edit
    void Y
  })
})

describe('what must NOT be mistaken for a bad op', () => {
  const setup = async () => {
    const store = new MemoryStore(), device = uuidv7()
    const c = new Client({ store, ws, device, sv: SV })
    await c.setFields(uuidv7(), { a: 1 }, 'page')
    await c.setFields(uuidv7(), { a: 2 }, 'page')
    return { store, device }
  }
  const failing = (e: NetError): Net => ({ push: async () => { throw e }, pull: async () => ({ ops: [], head: 0, more: false }) })

  it('426 upgrade_required (sv below the workspace minSv): the ops are KEPT until the app is updated, not quarantined', async () => {
    const { store, device } = await setup()
    await expect(new SyncEngine({ store, net: failing(new NetError(426, 'upgrade_required', false)), ws, device, sv: SV }).cycle()).rejects.toThrow()
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(2)
    expect(await store.run(tx => tx.listQuarantine())).toEqual([])
  })
  it('400 bad_request (about the batch) and 409 op_conflict: rethrown, nothing is quarantined', async () => {
    for (const e of [new NetError(400, 'bad_request', false), new NetError(409, 'op_conflict', false), new NetError(422, 'clock_ahead', false)]) {
      const { store, device } = await setup()
      await expect(new SyncEngine({ store, net: failing(e), ws, device, sv: SV }).cycle()).rejects.toThrow()
      expect((await store.run(tx => tx.listOutbox(10))).length, e.code).toBe(2)
      expect(await store.run(tx => tx.listQuarantine()), e.code).toEqual([])
    }
  })
})

describe('a batch is bounded by size (the server refuses a body over 4 MB with a permanent 413)', () => {
  it('three legal 1.4M-char ops are sent in separate batches and all arrive', async () => {
    const store = new MemoryStore(), device = uuidv7()
    const c = new Client({ store, ws, device, sv: SV })
    for (let i = 0; i < 3; i++) await c.setFields(uuidv7(), { big: 'x'.repeat(1_000_000) }, 'page') // ~1.33M chars of p each: legal
    const sizes: number[] = []
    const log: string[] = []
    const net: Net = {
      async push(_w, envs) {
        const total = envs.reduce((n, e) => n + e.length, 0)
        sizes.push(total)
        if (total > 4 * 1024 * 1024) throw new NetError(413, 'too_large', false)
        const results = envs.map(e => { const op = parseEnvelope(e).op; log.push(op); return { op, seq: log.length, status: 'ok' as const } })
        return { results, head: log.length }
      },
      async pull() { return { ops: [], head: log.length, more: false } },
    }
    const s = await new SyncEngine({ store, net, ws, device, sv: SV }).cycle()
    expect(s.pushed).toBe(3)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(sizes.length).toBeGreaterThanOrEqual(2) // really split
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(0)
  })
})
