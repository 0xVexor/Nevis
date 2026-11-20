// Starts the REAL Go server (built from ../../server) and runs the convergence harness against it. SEEDS=200 for the long run.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceToken } from '../src/account'
import { runSeed } from '../src/run'

const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
let proc: ChildProcess, dir: string, base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nevis-converge-'))
  const bin = join(dir, 'nevis-server')
  const b = spawnSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: new URL('../../../server', import.meta.url).pathname, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(`go build failed:\n${b.stderr}`)
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  proc = spawn(bin, [], { env: { ...process.env, DEV_MODE: '1', DEV_TOKEN: 'dev', REGISTRATION: 'open', POW_BITS: '6', PORT: String(port), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/v1/health`)).ok) return } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 50)) }
  throw new Error('server did not start')
})
afterAll(async () => { proc?.kill(); await new Promise(r => setTimeout(r, 300)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const SEEDS = Number(process.env.SEEDS ?? 10)
const OPS = Number(process.env.OPS ?? 800)

describe('convergence against the real server', () => {
  it(`${SEEDS} seeds x ${OPS} operations, 3 replicas, lost requests/answers, repeats, offline, crashes`, async () => {
    const failed: string[] = []
    let ops = 0, crashes = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await runSeed(seed, { server: base, token: 'dev', replicas: 3, ops: OPS })
      ops += r.stats.ops
      crashes += r.stats.crashes.afterLocalCommit + r.stats.crashes.afterPush + r.stats.crashes.afterPull
      if (!r.ok) failed.push(`seed ${seed}: ${r.reason}`)
    }
    console.log(`${SEEDS} seeds, ${ops} operations, ${crashes} crashes`)
    expect(failed).toEqual([])
  })

  it('with a real account (sessions, membership, quota accounting): the same convergence', async () => {
    const token = await deviceToken(base, `conv${Date.now().toString(36)}`, 'correct horse battery')
    for (let seed = 101; seed <= 105; seed++) {
      const r = await runSeed(seed, { server: base, token: 'dev', replicas: 3, ops: 500, account: { token } })
      expect(r.reason).toBeUndefined()
    }
  })

  it('a replica whose clock ran two hours ahead and was then fixed: nothing lost, everyone converges (422 clock_ahead)', async () => {
    let refused = 0, refusedByClock = 0
    for (let seed = 201; seed <= 210; seed++) {
      const r = await runSeed(seed, { server: base, token: 'dev', replicas: 3, ops: 600, clockAhead: true })
      expect(r.reason).toBeUndefined()
      refused += r.stats.netErrors
      refusedByClock += r.stats.clockAheadRefusals
    }
    expect(refused).toBeGreaterThan(0)
    expect(refusedByClock, 'the server must really have refused batches with 422 clock_ahead').toBeGreaterThan(0)
  })

  it('without any faults every op is delivered once and nothing is lost', async () => {
    const r = await runSeed(9001, { server: base, token: 'dev', replicas: 2, ops: 300, faults: { loseRequest: 0, loseResponse: 0, duplicate: 0 }, crashes: false })
    expect(r.reason).toBeUndefined()
    expect(r.stats.serverHead).toBe(300)
    expect(r.stats.lostRequests + r.stats.lostResponses + r.stats.duplicates).toBe(0)
  })
})
