import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../..', import.meta.url))
const app = path.join(root, 'spike/tiptap')
const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js')
const args = process.argv.slice(2)
const env = { ...process.env, NOVIQ_GITHUB_CREDENTIAL_SERVICE: 'app.noviq.github.preview' }
if (process.platform === 'win32') {
  // The GNU WebView2 binding dynamically imports WebView2Loader.dll. MSVC links its loader statically.
  const target = 'x86_64-pc-windows-msvc'
  const index = args.indexOf('--target')
  const inline = args.find(arg => arg.startsWith('--target='))
  const requested = index >= 0 ? args[index + 1] : inline?.slice('--target='.length)
  if ((index >= 0 || inline) && requested !== target) throw new Error(`Windows preview installers require --target ${target}.`)
  if (index < 0 && !inline) args.push('--target', target)
  // Override a GNU directory/default toolchain too, including builds invoked directly with npm.
  env.RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
}
const result = spawnSync(process.execPath, [cli, 'build', '--config', 'src-tauri/tauri.github-preview.conf.json', ...args], {
  cwd: app,
  stdio: 'inherit',
  env,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
