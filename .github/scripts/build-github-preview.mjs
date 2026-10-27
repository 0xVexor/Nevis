import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../..', import.meta.url))
const app = path.join(root, 'spike/tiptap')
const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js')
const result = spawnSync(process.execPath, [cli, 'build', '--config', 'src-tauri/tauri.github-preview.conf.json', ...process.argv.slice(2)], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, NOVIQ_GITHUB_CREDENTIAL_SERVICE: 'app.noviq.github.preview' },
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
