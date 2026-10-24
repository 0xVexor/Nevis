// Lists UI strings used as t('...') in the app that have no Persian entry in src/fa.ts.
// Usage: node db/check-i18n.mjs   (exit code 1 when something is missing)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const src = new URL('../spike/tiptap/src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(f) && f !== 'fa.ts' && f !== 'i18n.ts') files.push(p) // i18n.ts only mentions t('…') in a comment
  }
}
walk(src)

// keys are double-quoted JSON-ish strings at the start of lines in fa.ts
const faText = readFileSync(join(src, 'fa.ts'), 'utf8')
const have = new Set()
for (const m of faText.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) have.add(JSON.parse(`"${m[1]}"`))

const used = new Map() // key -> first file
const re = /\b(?:t|tr)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g // mermaid.ts imports t as tr
// slash-menu items are plain objects whose title/desc are translated when shown
const itemRe = /\b(?:title|desc):\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(re)) {
    if (m[1] === '`' && m[2].includes('${')) continue // dynamic: cannot be checked statically
    const key = m[2].replace(/\\(['"`\\])/g, '$1')
    if (!used.has(key)) used.set(key, f.replace(src, ''))
  }
  if (/slash\.ts$/.test(f))
    for (const m of text.matchAll(itemRe)) {
      const key = m[2].replace(/\\(['"`\\])/g, '$1')
      if (!used.has(key)) used.set(key, f.replace(src, ''))
    }
}

const SAME_IN_PERSIAN = new Set(['Callout', 'Toggle']) // product terms kept as they are
const missing = [...used].filter(([k]) => !have.has(k) && !SAME_IN_PERSIAN.has(k))
if (!missing.length) console.log(`i18n OK — ${used.size} strings, all have a Persian entry`)
else {
  console.log(`${missing.length} of ${used.size} strings have no Persian entry:`)
  for (const [k, f] of missing) console.log(`  ${JSON.stringify(k)}   (${f})`)
  process.exitCode = 1
}
