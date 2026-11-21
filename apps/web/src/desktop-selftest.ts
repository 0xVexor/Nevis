// `Nevis --self-test`: runs INSIDE the desktop app (real WebView, real Rust, real SQLite) and ends the process with an exit code.
//  1. the Store conformance suite on the SQLite adapter (ADR-0001 §2);
//  2. the sandbox of the network commands (a path outside /v1/ is refused);
//  3. with a server (NEVIS_SERVER): sign up as a device, the token stays in Rust, and a client syncs through Rust to the server and
//     back to a second device (the two ends of one account converge).
import { BlobSync, Client, MemoryBlobStore, MemoryStore, SyncEngine, blobStoreConformance, httpNet, sha256Hex, storeConformance } from '@nevis/core'
import { uuidv7, SV } from '@nevis/protocol'
import { createWorkspace, me, signUp, workspaces } from './auth'
import { appInfo, desktopBlobNet, desktopFetch, invoke, isDesktop, openDesktopBlobs, openDesktopStore } from './desktop'
import { harness, runAll, type Result } from './harness'

let n = 0
const run = Date.now()
storeConformance(harness, 'TauriStore (SQLite over IPC)', () => openDesktopStore(`selftest-${run}-${++n}`))
blobStoreConformance(harness, 'TauriBlobStore (files + SQLite over raw IPC)', () => openDesktopBlobs(`selftest-blobs-${run}-${++n}`))

const extra: Result[] = []
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); extra.push({ name, ok: true }) } catch (e) { extra.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
const must = (c: unknown, m: string) => { if (!c) throw new Error(m) }

async function main() {
  must(isDesktop, 'not running inside the desktop app')
  const results = await runAll()
  await check('Web Locks and BroadcastChannel exist in this WebView', async () => { must(!!navigator.locks, 'no navigator.locks'); must(typeof BroadcastChannel === 'function', 'no BroadcastChannel') })
  await check('net_request refuses paths outside /v1/ and hosts of its own choosing', async () => {
    for (const path of ['/other', '//evil.example/v1/x', '/v1/../x', 'http://evil.example/v1/x']) {
      let refused = false
      try { await invoke('net_request', { method: 'GET', path, body: null, requestId: null }) } catch { refused = true }
      must(refused, `accepted ${path}`)
    }
  })
  const info = await appInfo()
  if (info.server) {
    await check('sign up as a device: no token in what JavaScript gets; the token is in Rust (keychain/file)', async () => {
      const r = (await signUp(`st${run.toString(36)}`, 'correct horse battery', 'selftest', '')) as Record<string, unknown>
      must(!('token' in r) && !JSON.stringify(r).includes('"token"'), 'a token came back to JavaScript')
      must((await appInfo()).hasToken, 'Rust holds no token after sign-up')
      must((await me())?.account.username.startsWith('st'), 'me() failed with the stored token')
    })
    await check('JavaScript cannot obtain a token through net_request (sign-in/sign-up/recover paths are closed to it)', async () => {
      for (const path of ['/v1/auth/signin', '/v1/auth/signup', '/v1/auth/recover']) {
        let out: unknown = null
        try { out = await invoke('net_request', { method: 'POST', path, body: JSON.stringify({ username: `st${run.toString(36)}`, password: 'correct horse battery', client: 'device', deviceName: 'attack' }), requestId: null }) } catch { out = null }
        must(out === null, `net_request answered ${path}: ${JSON.stringify(out).slice(0, 80)}`)
      }
    })
    await check('a desktop device syncs through Rust: its change reaches a second device, and back', async () => {
      const ws = uuidv7(), page = uuidv7()
      await createWorkspace(ws, 'selftest')
      must((await workspaces()).some(w => w.id === ws), 'the workspace is not listed')
      const net = httpNet({ fetch: desktopFetch })
      const a = { store: openDesktopStore(ws), device: uuidv7() }
      const b = { store: new MemoryStore(), device: uuidv7() }
      const ca = new Client({ store: a.store, ws, device: a.device, sv: SV })
      const cb = new Client({ store: b.store, ws, device: b.device, sv: SV })
      const ea = new SyncEngine({ store: a.store, net, ws, device: a.device, sv: SV })
      const eb = new SyncEngine({ store: b.store, net, ws, device: b.device, sv: SV })
      await ca.setFields(page, { title: 'از دسکتاپ' }, 'page')
      await ea.cycle(); await eb.cycle()
      must((await b.store.run(tx => tx.getField(page, 'title')))?.val === JSON.stringify('از دسکتاپ'), 'the second device did not get the title')
      await cb.setFields(page, { count: 7 })
      await eb.cycle(); await ea.cycle()
      must((await a.store.run(tx => tx.getField(page, 'count')))?.val === '7', 'the desktop did not get the change back')
      must((await a.store.run(tx => tx.listOutbox(10))).length === 0, 'the outbox was not emptied')
    })
    await check('an attachment goes through Rust: files on disk, gated outbox, resumed upload, verified download on a second device', async () => {
      const ws = uuidv7(), page = uuidv7()
      await createWorkspace(ws, 'selftest-blobs')
      const net = httpNet({ fetch: desktopFetch })
      const bytes = new Uint8Array(5 << 20).map((_, i) => (i * 31 + 7) & 255) // 5 MB
      const data = new Blob([bytes])
      const hash = await sha256Hex(data)
      const store = openDesktopStore(ws)
      const blobs = openDesktopBlobs(ws)
      const dev = uuidv7()
      const sync = new BlobSync({ ws, blobs, net: desktopBlobNet(), pieceSize: 1 << 20, verifyTtlMs: 0 })
      const client = new Client({ store, ws, device: dev, sv: SV, blobs })
      const engine = new SyncEngine({ store, net, ws, device: dev, sv: SV, gate: sync })
      await blobs.put(hash, data, 'image/png')
      must((await blobs.meta(hash))?.remote === false, 'a new file must not be marked as on the server')
      await client.setFields(page, { blob: hash }, 'page')
      await engine.cycle()
      must((await store.run(tx => tx.listOutbox(10))).length === 1, 'the op left before its file was uploaded (the gate failed)')
      // a wrong hash is refused by Rust itself, nothing is kept
      let refused = false
      try { await blobs.put('f'.repeat(64), new Blob(['not that']), 'x/y') } catch { refused = true }
      must(refused && !(await blobs.meta('f'.repeat(64))), 'Rust kept bytes that do not match their hash')
      await sync.uploadPending()
      must((await blobs.meta(hash))?.remote === true, 'the file was not marked uploaded')
      await engine.cycle()
      must((await store.run(tx => tx.listOutbox(10))).length === 0, 'the op did not go after the upload')
      // a second device, with its own memory, downloads it in ranges and verifies it
      const other = new BlobSync({ ws, blobs: new MemoryBlobStore(), net: desktopBlobNet() })
      const got = await other.fetch(hash, 'image/png')
      must(!!got && got.size === bytes.length && (await sha256Hex(got)) === hash, 'the downloaded file is not identical')
      // and what Rust holds reads back identical
      const back = await blobs.get(hash)
      must(!!back && (await sha256Hex(back)) === hash, 'the file read back from disk differs')
    })
    await check('no response was ever blocked for holding the token', async () => { must((await appInfo()).blocked === 0, 'the guard blocked a response') })
  }
  const all = [...results, ...extra]
  const failed = all.filter(r => !r.ok)
  const report = [...all.map(r => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` — ${r.error}` : ''}`), '', `${all.length - failed.length}/${all.length} passed${info.server ? '' : ' (no server: network checks skipped)'}`].join('\n')
  document.getElementById('out')!.textContent = report
  await invoke('app_exit', { code: failed.length ? 1 : 0, report })
}
main().catch(async e => { await invoke('app_exit', { code: 2, report: `self-test crashed: ${String((e as Error)?.stack ?? e)}` }) })
