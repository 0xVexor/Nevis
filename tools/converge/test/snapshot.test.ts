// ROADMAP M13 against the REAL Go server: a snapshot lets a new device start from a compact log and get the same document; a purge removes a
// document everywhere, and a late write to it is refused ("purged").
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, MemoryStore, Snapshotter, SyncEngine, httpNet, loadDoc } from '@nevis/core'
import { SV, uuidv7 } from '@nevis/protocol'

const PORT = 18801
let go: ChildProcess, dir: string
const base = `http://127.0.0.1:${PORT}`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nevis-snap-'))
  const bin = join(dir, 'server')
  const b = spawnSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: new URL('../../../server', import.meta.url).pathname, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(b.stderr)
  go = spawn(bin, [], { env: { ...process.env, DEV_MODE: '1', DEV_TOKEN: 'dev', PORT: String(PORT), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/v1/health`)).ok) break } catch { /* not up */ } await new Promise(r => setTimeout(r, 50)) }
}, 120_000)
afterAll(() => { go?.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const device = (ws: string) => {
  const store = new MemoryStore(), id = uuidv7()
  const net = httpNet({ base, token: 'dev' })
  const client = new Client({ store, ws, device: id, sv: SV })
  const engine = new SyncEngine({ store, net, ws, device: id, sv: SV })
  return { store, net, client, engine }
}

describe('snapshot and purge on the real server', () => {
  it('a snapshot gives a new device the same document from a compact log; a purge removes it everywhere and a late write is refused', async () => {
    const ws = uuidv7(), page = uuidv7()
    const a = device(ws)
    await a.client.setFields(page, { title: 'پر ویرایش' }, 'page')
    const y = new Y.Doc()
    for (let i = 0; i < 150; i++) {
      const before = Y.encodeStateVector(y)
      y.getText('t').insert(y.getText('t').length, `کلمه${i} `)
      await a.client.writeYUpdate(page, Y.encodeStateAsUpdate(y, before))
    }
    await a.engine.cycle()
    // not ready before the cursor reached the head: the rule of Client.writeSnapshot
    expect(await new Snapshotter({ client: a.client, store: a.store, net: a.net, ws, minOps: 100, every: 0 }).run()).toBe(1)
    await a.engine.cycle() // pushes the snapshot
    // control: a normal pull returns every op; a new device (compact) gets far fewer
    const all = await a.net.pull(ws, 0, 1000)
    expect(all.ops.length).toBeGreaterThan(150)
    const b = device(ws)
    const stats = await b.engine.cycle()
    expect(stats.pulled).toBeLessThan(10) // the snapshot (and what it does not cover), not 150 updates
    const text = async (d: typeof a) => (await d.store.run(tx => loadDoc(tx, page))).getText('t').toString()
    expect(await text(b)).toBe(await text(a))
    expect(await b.store.run(tx => tx.getField(page, 'title'))).toMatchObject({ val: JSON.stringify('پر ویرایش') })
    // a late device with an op for this page (written before the purge, sent after it)
    const late = device(ws)
    await late.engine.cycle()
    await late.client.writeYUpdate(page, Y.encodeStateAsUpdate(new Y.Doc()))
    // the purge
    await a.client.purge(page)
    await a.engine.cycle()
    await b.engine.cycle()
    expect(await b.store.run(tx => tx.entities())).not.toContain(page)
    expect(await b.store.run(tx => tx.docs())).not.toContain(page)
    const after = await a.net.pull(ws, 0, 1000)
    expect(after.ops.filter(o => JSON.parse(o.env).doc === page).length).toBe(1) // only the purge op remains on the server
    const s = await late.engine.cycle()
    expect(s.dup + s.pushed).toBeGreaterThanOrEqual(1)
    expect((await late.store.run(tx => tx.listOutbox(10))).length).toBe(0) // answered "purged": the op left the outbox
    expect(await late.store.run(tx => tx.entities())).not.toContain(page) // and the purge reached the late device
  }, 120_000)
})
