import { describe, expect, it } from 'vitest'
import { SV, b64urlDecode, parseEnvelope, uuidv7 } from '@nevis/protocol'
import { BlobSync, Client, MemoryBlobStore, MemoryStore, NetError, SyncEngine, collectReferences, hashesIn, sha256Hex, type BlobNet, type Net, type PushResult } from '../src'

const ws = uuidv7()
const bytesOf = (n: number, seed = 1) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a[i] = x >> 16 } return a }
const blobOf = (n: number, seed = 1) => new Blob([bytesOf(n, seed)])

/** A server in memory that keeps what the real one promises: a blob exists only when complete and verified; every op it logs is
 *  checked at the moment it is accepted: all attachments it refers to must be complete (that is the invariant of M9). */
class FakeServer implements Net, BlobNet {
  log: { op: string; env: string }[] = []
  complete = new Map<string, Blob>()
  partial = new Map<string, Uint8Array>()
  violations: string[] = []
  known: string[] = []
  quotaFull = false
  maxBlob = Infinity
  failNext: (what: string) => boolean = () => false
  puts = 0
  refs: { cursor: number; refs: string[] }[] = []

  async push(_w: string, envs: string[]): Promise<PushResult> {
    if (this.failNext('push')) throw new NetError(0, 'unreachable', true)
    const results = envs.map(e => {
      const env = parseEnvelope(e)
      for (const h of hashesIn(b64urlDecode(env.p), this.known)) if (!this.complete.has(h)) this.violations.push(`${env.op} refers to ${h.slice(0, 6)} before it was complete`)
      this.log.push({ op: env.op, env: e })
      return { op: env.op, seq: this.log.length, status: 'ok' as const }
    })
    return { results, head: this.log.length }
  }
  async pull() { return { ops: [], head: this.log.length, more: false } }

  async head(_w: string, hash: string) {
    if (this.failNext('head')) throw new NetError(0, 'unreachable', true)
    const c = this.complete.get(hash)
    return c ? { stored: true as const, size: c.size } : { stored: false as const, received: this.partial.get(hash)?.length ?? 0 }
  }
  async put(_w: string, hash: string, piece: Blob, offset: number, total: number) {
    if (this.failNext('put')) throw new NetError(0, 'unreachable', true)
    if (total > this.maxBlob) throw new NetError(413, 'blob_too_large', false)
    if (this.quotaFull) throw new NetError(507, 'quota_exceeded', false)
    this.puts++
    const have = this.partial.get(hash) ?? new Uint8Array(0)
    if (offset > have.length) throw new NetError(409, 'out_of_order', false, 'x', { received: have.length })
    const next = new Uint8Array(offset + piece.size)
    next.set(have.subarray(0, offset)); next.set(new Uint8Array(await piece.arrayBuffer()), offset)
    this.partial.set(hash, next)
    if (next.length < total) return { complete: false, received: next.length }
    if ((await sha256Hex(next)) !== hash) { this.partial.delete(hash); throw new NetError(400, 'hash_mismatch', false) }
    this.partial.delete(hash)
    this.complete.set(hash, new Blob([next]))
    return { complete: true, received: total }
  }
  async get(_w: string, hash: string, start: number, end: number) {
    const c = this.complete.get(hash)
    if (!c) throw new NetError(404, 'no_such_blob', false)
    return { data: c.slice(start, end + 1), total: c.size }
  }
  async reportRefs(_w: string, cursor: number, refs: string[]) { this.refs.push({ cursor, refs }); return { applied: cursor >= this.log.length && cursor > 0 } }
}

function device(server: FakeServer, o: { pieceSize?: number } = {}) {
  const store = new MemoryStore()
  const blobs = new MemoryBlobStore()
  const id = uuidv7()
  const sync = new BlobSync({ ws, blobs, net: server, pieceSize: o.pieceSize ?? 1 << 20, verifyTtlMs: 0 })
  const client = new Client({ store, ws, device: id, sv: SV })
  const engine = new SyncEngine({ store, net: server, ws, device: id, sv: SV, gate: sync })
  const outbox = async () => (await store.run(tx => tx.listOutbox(1000)))
  return { store, blobs, sync, client, engine, outbox }
}

/** Adds an attachment as the app does: bytes and hash first, then the op that refers to it. */
async function attach(d: ReturnType<typeof device>, server: FakeServer, ent: string, n: number, seed: number) {
  const data = blobOf(n, seed)
  const hash = await sha256Hex(data)
  server.known.push(hash)
  await d.blobs.put(hash, data, 'image/png')
  await d.client.setFields(ent, { blob: hash }, 'page')
  return hash
}

describe('the outbox gate (ROADMAP M9: an op never reaches the server before its blob)', () => {
  it('holds the op, and the later ops of the same document, until the blob is complete; other documents go on', async () => {
    const server = new FakeServer()
    const d = device(server)
    const pageA = uuidv7(), pageB = uuidv7()
    const hash = await attach(d, server, pageA, 3 << 20, 1)
    await d.client.setFields(pageA, { title: 'later edit of the same page' }) // behind the gated op
    await d.client.setFields(pageB, { title: 'another page' })
    const row = (await d.outbox())[0]!
    expect(row.blobs).toEqual([hash]) // found by reading the op's content
    await d.engine.cycle()
    expect(server.log.length).toBe(1) // only the other page
    expect((await d.outbox()).length).toBe(2)
    await d.sync.uploadPending()
    await d.engine.cycle()
    expect(server.log.length).toBe(3)
    expect((await d.outbox()).length).toBe(0)
    expect(server.violations).toEqual([])
    expect(server.complete.has(hash)).toBe(true)
  })

  it('a connection that dies in the middle of an upload, again and again: no op ever precedes its blob, and the file arrives complete', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      let x = seed * 7919
      const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
      const server = new FakeServer()
      server.failNext = () => rnd() < 0.25
      const d = device(server, { pieceSize: 256 * 1024 })
      const pages = [uuidv7(), uuidv7(), uuidv7()]
      const hashes: string[] = []
      for (let i = 0; i < 3; i++) hashes.push(await attach(d, server, pages[i]!, 600 * 1024 + i * 1000, seed * 10 + i))
      for (let round = 0; round < 200 && ((await d.outbox()).length || (await d.blobs.pending()).length); round++) {
        await d.sync.uploadPending().catch(() => {})
        await d.engine.cycle().catch(() => {})
        expect(server.violations, `seed ${seed}`).toEqual([])
      }
      expect((await d.outbox()).length, `seed ${seed} outbox drained`).toBe(0)
      for (const h of hashes) expect(server.complete.has(h), `seed ${seed} blob`).toBe(true)
      expect(server.violations).toEqual([])
    }
  })

  it('control: WITHOUT the gate the same history does send an op before its blob (so the test above is not vacuous)', async () => {
    const server = new FakeServer()
    const d = device(server)
    const hash = await attach(d, server, uuidv7(), 1 << 20, 3)
    const ungated = new SyncEngine({ store: d.store, net: server, ws, device: uuidv7(), sv: SV })
    await ungated.cycle()
    expect(server.violations.length).toBe(1)
    expect(server.complete.has(hash)).toBe(false)
  })

  it('resumes from what the server holds instead of starting over', async () => {
    const server = new FakeServer()
    const d = device(server, { pieceSize: 1 << 20 })
    const hash = await attach(d, server, uuidv7(), 5 << 20, 4)
    let cut = 0
    server.failNext = w => w === 'put' && ++cut === 3 // the third piece fails
    await d.sync.uploadPending()
    expect(d.sync.status().error).toBe('offline')
    expect(server.partial.get(hash)!.length).toBe(2 << 20)
    server.failNext = () => false
    const before = server.puts
    await d.sync.uploadPending()
    expect(server.puts - before).toBe(3) // pieces 3, 4, 5 only
    expect(server.complete.get(hash)!.size).toBe(5 << 20)
  })

  it('a blob the server collected meanwhile is uploaded again and the op waits for it', async () => {
    const server = new FakeServer()
    const d = device(server)
    const page = uuidv7()
    const hash = await attach(d, server, page, 100_000, 5)
    await d.sync.uploadPending()
    expect((await d.blobs.meta(hash))!.remote).toBe(true)
    server.complete.delete(hash) // 30 days passed while this device was off
    await d.engine.cycle()
    expect(server.log.length).toBe(0)
    expect((await d.blobs.meta(hash))!.remote).toBe(false)
    await d.sync.uploadPending()
    await d.engine.cycle()
    expect(server.log.length).toBe(1)
    expect(server.violations).toEqual([])
  })

  it('a name the device only holds as a DOWNLOADED file (remote = true) is checked too: the server dropped it, a new op names it again -> held, re-uploaded from local bytes, then sent', async () => {
    const server = new FakeServer()
    const a = device(server)
    const hash = await attach(a, server, uuidv7(), 50_000, 11)
    await a.sync.uploadPending()
    const b = device(server)
    await b.sync.fetch(hash, 'image/png') // b holds it as a downloaded file: remote = true, never pending
    expect((await b.blobs.meta(hash))!.remote).toBe(true)
    server.complete.delete(hash) // 30 days later the server collected it
    server.known.push(hash)
    const page = uuidv7()
    await b.client.setFields(page, { blob: hash }, 'page') // the user pastes the picture back in
    expect((await b.outbox())[0]!.blobs).toEqual([hash]) // the gate is recorded although nothing was pending
    await b.engine.cycle()
    expect(server.log.length).toBe(0) // held: the server does not have it
    expect((await b.blobs.meta(hash))!.remote).toBe(false)
    await b.sync.uploadPending()
    await b.engine.cycle()
    expect(server.log.length).toBe(1)
    expect(server.violations).toEqual([])
    expect(server.complete.has(hash)).toBe(true)
  })

  it('a file the server can never take does not hold the page for ever (and says why)', async () => {
    const server = new FakeServer()
    server.maxBlob = 1000
    const d = device(server)
    const page = uuidv7()
    const hash = await attach(d, server, page, 5000, 6)
    await d.sync.uploadPending()
    expect((await d.blobs.meta(hash))!.failed).toBe('blob_too_large')
    expect(d.sync.status().error).toBe('blob_too_large')
    await d.engine.cycle()
    expect(server.log.length).toBe(1) // released
    expect(await d.blobs.get(hash)).toBeDefined() // and the local file is intact
  })

  it('a full quota: a clear status, the local file intact, the op still waiting; room again -> it goes', async () => {
    const server = new FakeServer()
    server.quotaFull = true
    const d = device(server)
    const page = uuidv7()
    const hash = await attach(d, server, page, 10_000, 7)
    await d.sync.uploadPending()
    expect(d.sync.status().error).toBe('quota')
    expect(await d.blobs.get(hash)).toBeDefined()
    await d.engine.cycle()
    expect(server.log.length).toBe(0)
    expect((await d.outbox()).length).toBe(1)
    server.quotaFull = false
    await d.sync.uploadPending()
    await d.engine.cycle()
    expect(server.log.length).toBe(1)
    expect(d.sync.status().error).toBe('')
  })
})

describe('download', () => {
  it('fetches in ranges, verifies the hash, keeps it; wrong bytes are never kept; a missing file is "not yet"', async () => {
    const server = new FakeServer()
    const a = device(server)
    const hash = await attach(a, server, uuidv7(), 9 << 20, 8)
    await a.sync.uploadPending()
    const b = device(server)
    const got = await b.sync.fetch(hash, 'image/png')
    expect(got!.size).toBe(9 << 20)
    expect((await b.blobs.meta(hash))!.remote).toBe(true)
    // corrupt bytes on the server
    const bad = 'f'.repeat(64)
    server.complete.set(bad, blobOf(100, 99))
    const c = device(server)
    expect(await c.sync.fetch(bad)).toBeUndefined()
    expect(await c.blobs.get(bad)).toBeUndefined()
    expect(await c.sync.fetch('e'.repeat(64))).toBeUndefined()
  })
})

describe('references for the server garbage collection', () => {
  it('finds the hashes in documents, registers and events, and refuses to report while ops wait in the inbox', async () => {
    const server = new FakeServer()
    const d = device(server)
    const page = uuidv7()
    const h1 = await attach(d, server, page, 1000, 9)
    const h2 = 'c'.repeat(64)
    await d.client.addEvent(page, 'version', { image: h2 })
    const r = await collectReferences(d.store)
    expect(r && [...r.refs].sort()).toEqual([h1, h2].sort())
    await d.store.run(tx => tx.putInbox({ seq: 1, env: '{}' }))
    expect(await collectReferences(d.store)).toBeNull()
  })

  it('reports the hashes of ops that went out (a list that only keeps blobs), then the complete list once a day', async () => {
    const server = new FakeServer()
    const d = device(server)
    const hash = await attach(d, server, uuidv7(), 1000, 10)
    await d.sync.uploadPending()
    await d.engine.cycle()
    await d.store.run(tx => tx.setMeta('cursor', String(server.log.length))) // as after a pull that returned this device's own ops
    await d.sync.reportRefs(d.store)
    expect(server.refs[0]).toEqual({ cursor: 0, refs: [hash] })
    expect(server.refs[1]!.refs).toEqual([hash])
    const n = server.refs.length
    await d.sync.reportRefs(d.store)
    expect(server.refs.length).toBe(n) // not again within a day
  })
})
