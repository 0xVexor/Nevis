import { describe, expect, it } from 'vitest'
import { SV, parseEnvelope, uuidv7 } from '@nevis/protocol'
import { Client, MemoryStore, NetError, Snapshotter, SyncEngine, type Net } from '../src'

const ws = uuidv7()

describe('a cursor inside the part of the log the server removed (410 resync_required)', () => {
  it('starts again from a compact pull at cursor 0 and keeps the local state', async () => {
    const store = new MemoryStore()
    const device = uuidv7()
    const c = new Client({ store, ws, device, sv: SV })
    const page = uuidv7()
    await c.setFields(page, { title: 'محلی' }, 'page')
    await store.run(tx => tx.setMeta('cursor', '7')) // a device that stopped at seq 7
    const asked: { after: number; compact: boolean }[] = []
    const net: Net = {
      async push(_w, envs) { return { results: envs.map((e, i) => ({ op: parseEnvelope(e).op, seq: 100 + i, status: 'ok' as const })), head: 120 } },
      async pull(_w, after, _l, opts) {
        asked.push({ after, compact: !!opts?.compact })
        if (after === 7) throw new NetError(410, 'resync_required', false)
        return { ops: [], head: 120, more: false }
      },
    }
    await new SyncEngine({ store, net, ws, device, sv: SV }).cycle()
    expect(asked).toEqual([{ after: 7, compact: false }, { after: 0, compact: true }])
    expect(await store.run(tx => tx.getMeta('cursor'))).toBe('120') // an empty compact answer ends at the head
    expect(await store.run(tx => tx.getField(page, 'title'))).toMatchObject({ val: '"محلی"' }) // nothing local was cleared
  })
  it('a snapshot is written only when the cursor has reached the head and the inbox is empty', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws, device: uuidv7(), sv: SV })
    const page = uuidv7()
    await c.setFields(page, { title: 'x' }, 'page')
    expect(await c.writeSnapshot(page)).toBeNull() // cursor 0
    await store.run(async tx => { await tx.setMeta('cursor', '5'); await tx.setMeta('head', '6') })
    expect(await c.writeSnapshot(page)).toBeNull() // the server has more than this device has pulled
    await store.run(async tx => { await tx.setMeta('head', '5'); await tx.putInbox({ seq: 5, env: '{}' }) })
    expect(await c.writeSnapshot(page)).toBeNull() // something waits in the inbox (maybe held for a newer schema)
    await store.run(tx => tx.deleteInbox([5]))
    expect(await c.writeSnapshot(page)).not.toBeNull()
    const last = (await store.run(tx => tx.listOutbox(10))).at(-1)!
    expect(parseEnvelope(last.env).cov).toBe(5)
  })

  it('a document too large for one snapshot op is skipped: the others still get theirs, and the next round does not ask again at once', async () => {
    const store = new MemoryStore()
    const c = new Client({ store, ws, device: uuidv7(), sv: SV })
    const big = uuidv7(), small = uuidv7()
    await c.setFields(big, { a: 'x'.repeat(900_000) }, 'page')
    await c.setFields(big, { b: 'y'.repeat(900_000) }) // two registers, each fine as an op; together over the limit of one snapshot
    await c.setFields(small, { title: 'کوچک' }, 'page')
    await store.run(async tx => { await tx.setMeta('cursor', '5'); await tx.setMeta('head', '5') })
    let asked = 0
    const net = { candidates: async () => { asked++; return [big, small] } } as unknown as Net
    const snap = new Snapshotter({ client: c, store, net, ws, minOps: 1, every: 3600_000, now: () => 10_000_000 })
    expect(await snap.run()).toBe(1) // `small` got its snapshot although `big` could not
    expect(await snap.run()).toBe(0) // and the server is not asked again within the hour
    expect(asked).toBe(1)
  })
})
