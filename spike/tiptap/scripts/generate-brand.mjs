import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { BRAND_PATHS } from '../src/brand/mark.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const paths = BRAND_PATHS.map(d => `<path d="${d}"/>`).join('')
const mark = `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${mark}><style>:root{color:#087f74}@media(prefers-color-scheme:dark){:root{color:#65b5a7}}</style>${paths}</svg>\n`
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="104" fill="#087f74"/><g transform="translate(88 88) scale(14)" color="#ffffff" ${mark}>${paths}</g></svg>\n`
for (const [path, content] of [[resolve(root, 'public/favicon.svg'), favicon], [resolve(root, '../../docs/favicon.svg'), favicon], [resolve(root, 'src-tauri/app-icon.svg'), appIcon]]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
if (process.argv.includes('--icons')) {
  const generated = resolve(root, '../../artifacts/new-brand-icons')
  execFileSync(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', resolve(root, 'src-tauri/app-icon.svg'), '--output', generated], { cwd: root, stdio: 'inherit', windowsHide: true })
  const target = resolve(root, 'src-tauri/icons')
  for (const file of await readdir(target, { withFileTypes: true })) {
    if (file.isFile() && /\.(png|ico|icns)$/.test(file.name)) await copyFile(resolve(generated, file.name), resolve(target, file.name))
  }
}
console.log('Brand assets generated from src/brand/mark.ts. Use --icons to regenerate the existing desktop icon set too.')
