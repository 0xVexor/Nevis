// Builds and starts the real Go server on 8787 (the Vite dev server proxies /v1 to it) for the whole test run.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let proc: ChildProcess | null = null
export default async function globalSetup() {
  try { if ((await fetch('http://127.0.0.1:8787/v1/health')).ok) return } catch { /* none running: start ours */ }
  const dir = mkdtempSync(join(tmpdir(), 'nevis-web-e2e-'))
  const bin = join(dir, 'nevis-server')
  const b = spawnSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: new URL('../../../server', import.meta.url).pathname, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(`go build failed:\n${b.stderr}`)
  proc = spawn(bin, [], { env: { ...process.env, DEV_MODE: '1', DEV_TOKEN: 'dev', REGISTRATION: 'open', POW_BITS: '8', PORT: '8787', LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:8787/v1/health')).ok) break } catch { /* not up */ } await new Promise(r => setTimeout(r, 50)) }
  return async () => { proc?.kill(); await new Promise(r => setTimeout(r, 300)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
