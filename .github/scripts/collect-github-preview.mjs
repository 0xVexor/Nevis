import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
const root = fileURLToPath(new URL('../..', import.meta.url))
const platform = process.argv[2]
if (!['macos', 'windows'].includes(platform)) throw new Error('Expected macos or windows')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const folder = path.resolve(root, process.env.NOVIQ_PREVIEW_OUTPUT || 'artifacts/github-preview', platform)
const bundle = process.env.NOVIQ_PREVIEW_TARGET_DIR || path.join(root, 'spike/tiptap/src-tauri/target')
const executable = path.join(bundle, platform === 'macos' ? 'universal-apple-darwin/release/nevis' : 'release/nevis.exe')
const binary = await fs.readFile(executable)
for (const marker of ['com.vexor.noviq.githubpreview', 'app.noviq.github.preview']) {
  if (!binary.includes(Buffer.from(marker))) throw new Error('Preview isolation marker missing in executable: ' + marker)
}
async function walk(dir) {
  const rows = await fs.readdir(dir, { withFileTypes: true })
  return (await Promise.all(rows.map((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name)))).flat()
}
let input = process.argv[3]
if (!input && platform === 'windows') {
  const matches = (await walk(path.join(bundle, 'release/bundle/nsis'))).filter((f) => /[-_]setup\.exe$/i.test(f))
  if (matches.length !== 1) throw new Error('Expected exactly one NSIS installer')
  input = matches[0]
}
if (!input) throw new Error('Installer path is required')
const label = platform === 'macos' ? 'macOS-universal' : 'Windows-x64'
const name = `Nevis-GitHub-Preview-${label}-${commit.slice(0, 7)}.${platform === 'macos' ? 'pkg' : 'exe'}`
await fs.mkdir(folder, { recursive: true })
await fs.copyFile(path.resolve(input), path.join(folder, name))
const hash = createHash('sha256')
for await (const chunk of createReadStream(path.join(folder, name))) hash.update(chunk)
const checksum = hash.digest('hex')
await fs.writeFile(path.join(folder, 'SHA256SUMS.txt'), `${checksum}  ${name}\n`)
const publicApp = JSON.parse(await fs.readFile(path.join(root, 'spike/tiptap/src-tauri/github-app.public.json'), 'utf8'))
const configured = !!((process.env.NOVIQ_GITHUB_CLIENT_ID?.trim() || publicApp.clientId) && (process.env.NOVIQ_GITHUB_APP_SLUG?.trim() || publicApp.slug))
await fs.writeFile(path.join(folder, 'BUILD-INFO.json'), JSON.stringify({
  commit, platform: label, builtAt: new Date().toISOString(),
  identifier: 'com.vexor.noviq.githubpreview', credentialService: 'app.noviq.github.preview',
  githubAppConfigured: configured, unsignedTestBuild: true,
}, null, 2) + '\n')
await fs.writeFile(path.join(folder, 'TESTING.md'), `# Nevis GitHub Preview\n\nCommit: ${commit}\nPlatform: ${label}\n\nThis unsigned test installer installs beside the production app, with a separate app-data directory and GitHub credential service. No merge, public release or auto-update is performed.\n\nUse a fresh vault or a **copy** of an existing vault. Do not open the same vault folder in two app versions simultaneously.\n\nGitHub sign-in configured: **${configured ? 'yes' : 'no — publisher App client ID and slug are still required'}**. The core editor works offline.\n\nبرای تست، فضای کاری تازه یا کپی یک فضای کاری را باز کنید. نسخه آزمایشی کنار برنامه اصلی نصب می‌شود و تنظیمات جدا دارد. این بسته امضا و notarize نشده است.\n\nSee docs/github-personal-vaults.md for setup, migration and size limits.\n`)
console.log(JSON.stringify({ folder, name, checksum, githubAppConfigured: configured }))
