// pnpm nevis import-legacy <pages.json | vaultDir> [out.nevis.zip]
// Turns the old app's pages (a JSON array as `repo.dump()` writes it; in a folder: `pages.json`) into a bundle, and prints what came across.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { legacyToBundle, type LegacyPage } from '../src'

const [cmd, input, out = 'legacy.nevis.zip'] = process.argv.slice(2)
if (cmd !== 'import-legacy' || !input) { console.error('usage: nevis import-legacy <pages.json | vaultDir> [out.nevis.zip]'); process.exit(2) }
const file = statSync(input).isDirectory() ? join(input, 'pages.json') : input
const pages = JSON.parse(readFileSync(file, 'utf8')) as LegacyPage[]
if (!Array.isArray(pages)) { console.error(`${file} is not an array of pages`); process.exit(2) }
const { zip, report } = await legacyToBundle(pages)
writeFileSync(out, zip)
console.log(JSON.stringify({ written: out, bytes: zip.length, ...report }, null, 2))
