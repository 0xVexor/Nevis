// Shared by the desktop automation scripts: build the web bundle and the app (with the bundle embedded), start a throwaway Go
// server, run the app binary in one of its automated modes with its own data folder and a file token store (no keychain prompt).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = fileURLToPath(new URL('..', import.meta.url))
const root = join(here, '..', '..')
export const bin = join(here, 'src-tauri/target/debug/nevis-desktop' + (process.platform === 'win32' ? '.exe' : ''))

export function build() {
  execFileSync(join(root, 'apps/web/node_modules/.bin/vite'), ['build', '--logLevel', 'error'], { cwd: join(root, 'apps/web'), stdio: 'inherit' })
  // the bundle is compiled INTO the binary (custom-protocol), so a changed bundle needs the crate rebuilt
  execFileSync('touch', [join(here, 'src-tauri/src/lib.rs')])
  execFileSync('cargo', ['build', '--features', 'custom-protocol', '--manifest-path', join(here, 'src-tauri/Cargo.toml')], { stdio: 'inherit' })
}

export async function startServer(port = 8791) {
  const dir = mkdtempSync(join(tmpdir(), 'nevis-desktop-srv-'))
  const exe = join(dir, 'nevis-server')
  execFileSync('go', ['build', '-o', exe, './cmd/nevis-server'], { cwd: join(root, 'server'), stdio: 'inherit' })
  const proc = spawn(exe, [], { env: { ...process.env, SESSION_SECRET: 'x'.repeat(40), REGISTRATION: 'open', POW_BITS: '8', PORT: String(port), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break } catch { /* not yet */ } await new Promise(r => setTimeout(r, 50)) }
  return { url: `http://127.0.0.1:${port}`, stop: () => proc.kill() }
}

/** A fresh app data folder and token file. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'nevis-desktop-app-'))
  mkdirSync(dir, { recursive: true })
  return { dataDir: join(dir, 'data'), tokenFile: join(dir, 'tokens.txt') }
}

export function appEnv(sb, extra = {}) {
  return { ...process.env, NEVIS_DATA_DIR: sb.dataDir, NEVIS_TEST_TOKEN_FILE: sb.tokenFile, ...extra }
}

/** Runs the app in a mode to the end; resolves { code, out }. */
export function runApp(args, env, timeoutMs = 180_000) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: 124, out: out + '\ntimeout' }) }, timeoutMs)
    p.on('exit', code => { clearTimeout(t); resolve({ code, out }) })
  })
}
