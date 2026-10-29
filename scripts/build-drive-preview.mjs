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
