// ROADMAP M9 acceptance, against the REAL Go server: a 50 MB blob completes although the connection is cut in the middle of pieces, and the
// op that refers to it never reaches the server before the blob is complete there (checked by a proxy that looks at every push).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BlobSync, Client, MemoryBlobStore, MemoryStore, SyncEngine, hashesIn, httpBlobNet, httpNet, sha256Hex } from '@nevis/core'
import { SV, b64urlDecode, parseEnvelope, uuidv7 } from '@nevis/protocol'

const GO_PORT = 18797, PROXY_PORT = 18798
let go: ChildProcess, proxy: Server, dir: string
const violations: string[] = []
let cuts = 0, puts = 0
const known: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nevis-blob-large-'))
  const bin = join(dir, 'server')
  const b = spawnSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: new URL('../../../server', import.meta.url).pathname, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(b.stderr)
  go = spawn(bin, [], { env: { ...process.env, DEV_MODE: '1', DEV_TOKEN: 'dev', PORT: String(GO_PORT), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'), MAX_BLOB_MB: '100' }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${GO_PORT}/v1/health`)).ok) break } catch { /* not up */ } await new Promise(r => setTimeout(r, 50)) }
  // the proxy: cuts every third piece of an upload in half, and looks at every push
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const isPut = req.method === 'PUT' && req.url!.includes('/blobs/')
      if (isPut && ++puts % 3 === 0) { // cut: send half of the piece, then drop the client's connection
        cuts++
        const up = httpRequest({ host: '127.0.0.1', port: GO_PORT, path: req.url, method: 'PUT', headers: { ...req.headers, 'content-length': String(body.length) } })
        up.on('error', () => undefined)
        up.write(body.subarray(0, body.length >> 1)); up.destroy()
        req.socket.destroy()
        return
      }
      if (req.method === 'POST' && req.url!.endsWith('/ops')) {
        for (const e of JSON.parse(body.toString()).ops as { p: string; op: string }[]) {
          for (const h of hashesIn(b64urlDecode(e.p), known)) {
            const r = await fetch(`http://127.0.0.1:${GO_PORT}/v1/ws/${req.url!.split('/')[3]}/blobs/${h}`, { method: 'HEAD', headers: { Authorization: 'Bearer dev' } })
            if (r.status !== 200) violations.push(`op ${e.op} reached the server before blob ${h.slice(0, 8)}`)
          }
        }
      }
      const up = httpRequest({ host: '127.0.0.1', port: GO_PORT, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode!, r.headers); r.pipe(res) })
      up.on('error', () => res.destroy())
      up.end(body)
    })
  })
  await new Promise<void>(r => proxy.listen(PROXY_PORT, '127.0.0.1', r))
}, 120_000)
afterAll(() => { proxy?.close(); go?.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('50 MB blob against the real server', () => {
  it('completes with the connection cut in the middle of pieces; the op that names it goes only after; a wrong hash is 400', async () => {
    const ws = uuidv7()
    const base = `http://127.0.0.1:${PROXY_PORT}`
    const bytes = new Uint8Array(50 << 20)
    for (let i = 0; i < bytes.length; i += 4) { const v = (i * 2654435761) >>> 0; bytes[i] = v; bytes[i + 1] = v >> 8; bytes[i + 2] = v >> 16; bytes[i + 3] = v >> 24 }
    const data = new Blob([bytes])
    const hash = await sha256Hex(bytes)
    known.push(hash)
    const store = new MemoryStore(), blobs = new MemoryBlobStore(), device = uuidv7()
    const sync = new BlobSync({ ws, blobs, net: httpBlobNet({ base, token: 'dev' }), pieceSize: 2 << 20, verifyTtlMs: 0 })
    const client = new Client({ store, ws, device, sv: SV })
    const engine = new SyncEngine({ store, net: httpNet({ base, token: 'dev' }), ws, device, sv: SV, gate: sync })
    await blobs.put(hash, data, 'application/octet-stream')
    await client.setFields(uuidv7(), { blob: hash }, 'page')
    let rounds = 0
    const t0 = Date.now()
    while (((await blobs.pending()).length || (await store.run(tx => tx.listOutbox(5))).length) && rounds++ < 300) {
      await sync.uploadPending().catch(() => undefined)
      await engine.cycle().catch(() => undefined)
    }
    const secs = (Date.now() - t0) / 1000
    expect(cuts).toBeGreaterThanOrEqual(5) // the connection really was cut, several times
    expect((await store.run(tx => tx.listOutbox(5))).length).toBe(0)
    expect(violations).toEqual([])
    // what the server holds is byte-identical
    const back = await new BlobSync({ ws, blobs: new MemoryBlobStore(), net: httpBlobNet({ base: `http://127.0.0.1:${GO_PORT}`, token: 'dev' }) }).fetch(hash)
    expect(back && (await sha256Hex(back)) === hash).toBe(true)
    console.log(`50 MB uploaded through ${cuts} cut connections in ${rounds} rounds, ${secs.toFixed(1)} s`)
    // wrong hash: 400, nothing kept
    const bad = await fetch(`http://127.0.0.1:${GO_PORT}/v1/ws/${ws}/blobs/${'e'.repeat(64)}?offset=0&total=5`, { method: 'PUT', headers: { Authorization: 'Bearer dev', 'Nevis-Proto': '1' }, body: 'hello' })
    expect(bad.status).toBe(400)
  }, 300_000)
})
