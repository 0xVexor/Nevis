// Builds the data block of docs/design-system/index.html (the live reference page): icons, page glyphs, backgrounds and file kinds,
// read straight from the design-system sources so the reference can never drift from the code.
// Run after changing iconData.ts, backgrounds.ts or fileKinds.ts:  node scripts/design-system-data.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../src')
const load = (...parts) => import(pathToFileURL(resolve(src, ...parts)).href)

const [{ ICON_GROUPS }, { BACKGROUNDS, BACKGROUND_GROUPS }, { FILE_KINDS, FILE_EXTENSIONS }] = await Promise.all([
  load('design-system', 'iconData.ts'),
  load('design-system', 'backgrounds.ts'),
  load('design-system', 'fileKinds.ts'),
])
const { MORE_GLYPHS } = await load('iconSetMore.ts')
const { EXTRA_GLYPHS } = await load('iconSetExtra.ts')

// the main GLYPHS table lives in a .tsx file next to JSX, so read its object literal instead of importing the file
const iconSet = readFileSync(resolve(src, 'iconSet.tsx'), 'utf8')
const start = iconSet.indexOf('export const GLYPHS')
const open = iconSet.indexOf('= {', start) + 2
const close = iconSet.indexOf('\n}\n', open) + 2
const GLYPHS = new Function('return ' + iconSet.slice(open, close))()

const glyphs = Object.entries({ ...GLYPHS, ...MORE_GLYPHS, ...EXTRA_GLYPHS }).map(([name, [kw, svg]]) => [name, kw, svg])
const data = {
  icons: ICON_GROUPS.map((g) => ({ id: g.id, label: g.label, icons: Object.entries(g.icons).map(([name, [kw, svg]]) => [name, kw, svg]) })),
  glyphs,
  backgrounds: BACKGROUNDS,
  backgroundGroups: BACKGROUND_GROUPS,
  fileKinds: FILE_KINDS,
  extensions: FILE_EXTENSIONS,
}

// The data is inlined between two markers: a page opened from disk or in a preview pane cannot always load a sibling script.
const page = resolve(here, '../../../docs/design-system/index.html')
const html = readFileSync(page, 'utf8')
const json = JSON.stringify(data).replace(/</g, '\\u003c')
const block = '<!--DS_DATA_START-->\n<script>window.DS_DATA = ' + json + ';</script>\n<!--DS_DATA_END-->'
const pattern = /<!--DS_DATA_START-->[\s\S]*?<!--DS_DATA_END-->/
if (!pattern.test(html)) throw new Error('DS_DATA markers not found in ' + page)
writeFileSync(page, html.replace(pattern, () => block))

const count = data.icons.reduce((n, g) => n + g.icons.length, 0)
console.log(`icons ${count}, page glyphs ${glyphs.length}, backgrounds ${BACKGROUNDS.length}, file kinds ${Object.keys(FILE_KINDS).length}`)
