import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
const root = fileURLToPath(new URL('..', import.meta.url))
const app = path.join(root, 'spike/tiptap')
const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js')
const args = process.argv.slice(2)
const cargoBin = path.join(os.homedir(), '.cargo', 'bin')
const env = { ...process.env, PATH: [process.env.PATH, ...(fs.existsSync(cargoBin) ? [cargoBin] : [])].filter(Boolean).join(path.delimiter), NEVIS_DRIVE_SYNC_ENABLED: '1', NEVIS_GOOGLE_CREDENTIAL_SERVICE: 'nevis.drive.preview.v1' }
// Publisher setup happens on the build machine, never in the customer's UI.
// Prefer CI/build environment. On this Mac reuse the developer value explicitly
// saved during setup; capture it in memory and never echo stdout/stderr.
if (!env.NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET && env.NEVIS_GOOGLE_DEVELOPER_SETUP !== '1' && process.platform === 'darwin') {
  const identity = env.NEVIS_GOOGLE_CLIENT_ID ?? JSON.parse(fs.readFileSync(path.join(app, 'src-tauri/google-oauth.public.json'), 'utf8')).clientId
  const saved = spawnSync('/usr/bin/security', ['find-generic-password', '-s', env.NEVIS_GOOGLE_CREDENTIAL_SERVICE, '-a', `desktop-client:${identity}`, '-w'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (saved.status === 0) env.NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET = saved.stdout.trim()
}
if (!env.NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET && env.NEVIS_GOOGLE_DEVELOPER_SETUP !== '1') {
  throw new Error('Publisher OAuth configuration is missing on the build machine. Supply NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET through the CI/build environment. Customer builds cannot ask users for this value.')
}
if (process.platform === 'win32') {
  const target = 'x86_64-pc-windows-msvc'
  const index = args.indexOf('--target'), inline = args.find(arg => arg.startsWith('--target='))
  const requested = index >= 0 ? args[index + 1] : inline?.slice('--target='.length)
  if ((index >= 0 || inline) && requested !== target) throw new Error(`Windows preview requires --target ${target}.`)
  if (index < 0 && !inline) args.push('--target', target)
  env.RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
}
const result = spawnSync(process.execPath, [cli, 'build', '--config', 'src-tauri/tauri.drive-preview.conf.json', ...args], { cwd: app, stdio: 'inherit', env })
if (result.error) throw result.error
process.exit(result.status ?? 1)
