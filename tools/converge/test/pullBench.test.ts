// ROADMAP M13 numbers: the first pull of a new device, with and without snapshots, and the base64 overhead of the payload (ADR-0008).
// 2000 documents with 25 Yjs updates each (a page edited a while), a snapshot of each, against the real Go server. Printed, not asserted.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { Client, MemoryStore, Snapshotter, SyncEngine, httpNet } from '@nevis/core'
import { SV, b64urlDecode, parseEnvelope, uuidv7 } from '@nevis/protocol'

const PORT = 18802
let go: ChildProcess, dir: string
const base = `http://127.0.0.1:${PORT}`
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nevis-pullbench-'))
  const bin = join(dir, 'server')
  const b = spawnSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: new URL('../../../server', import.meta.url).pathname, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(b.stderr)
  go = spawn(bin, [], { env: { ...process.env, DEV_MODE: '1', DEV_TOKEN: 'dev', PORT: String(PORT), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/v1/health`)).ok) break } catch { /* not up */ } await new Promise(r => setTimeout(r, 50)) }
}, 120_000)
afterAll(() => { go?.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('first pull with and without snapshots', () => {
  it('prints sizes and times', { timeout: 600_000 }, async () => {
    const ws = uuidv7(), N = 2000, UPD = 25
    const store = new MemoryStore(), device = uuidv7()
    const net = httpNet({ base, token: 'dev' })
    const client = new Client({ store, ws, device, sv: SV })
    const engine = new SyncEngine({ store, net, ws, device, sv: SV, batch: 500 })
    const docs: string[] = []
    for (let i = 0; i < N; i++) {
      const id = uuidv7(); docs.push(id)
      await client.setFields(id, { title: `صفحه ${i}`, parent: '', sortKey: 'a' + String(i).padStart(5, '0'), trashed: false, kind: 'doc', createdAt: 1 }, 'page')
      const y = new Y.Doc()
      for (let k = 0; k < UPD; k++) { const sv = Y.encodeStateVector(y); y.getText('t').insert(y.getText('t').length, `کلمهٔ شمارهٔ ${k} در صفحهٔ ${i} با متن فارسی و english. `); await client.writeYUpdate(id, Y.encodeStateAsUpdate(y, sv)) }
      if (i % 200 === 199) await engine.cycle()
    }
    await engine.cycle(); await engine.cycle()
    const raw = await net.pull(ws, 0, 1000)
    const sample = raw.ops.slice(0, 300)
    const b64 = sample.reduce((n, o) => n + parseEnvelope(o.env).p.length, 0)
    const bin = sample.reduce((n, o) => n + b64urlDecode(parseEnvelope(o.env).p).length, 0)
    const measure = async (compact: boolean) => {
      let bytes = 0, ops = 0, after = 0
      const t0 = performance.now()
      for (;;) {
        const res = await fetch(`${base}/v1/ws/${ws}/ops?after=${after}&limit=1000${compact ? '&compact=1' : ''}`, { headers: { Authorization: 'Bearer dev' } })
        const text = await res.text(); bytes += text.length
        const j = JSON.parse(text) as { ops: { seq: number }[]; more: boolean }
        ops += j.ops.length; after = j.ops.at(-1)?.seq ?? after
        if (!j.more) break
      }
      return { ops, bytes, seconds: (performance.now() - t0) / 1000 }
    }
    const full = await measure(false)
    // snapshots of every document (min 1 op), a few hundred per round
    const snap = new Snapshotter({ client, store, net, ws, minOps: 2, every: 0, perRun: 50 })
    let written = 0
    for (let r = 0; r < 60 && written < N; r++) { await engine.cycle(); written += await snap.run() }
    await engine.cycle(); await engine.cycle()
    const compact = await measure(true)
    console.log(JSON.stringify({ docs: N, updatesPerDoc: UPD, snapshots: written, fullPull: full, compactPull: compact, base64Overhead: +(b64 / bin).toFixed(3) }))
  })
})
