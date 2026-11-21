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
    void Y
  })
})
