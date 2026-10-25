// Writes a synthetic Obsidian-style vault for performance testing:  node scripts/gen-vault.mjs <outDir> [notes=870] [linksPerNote=5]
// Notes sit in nested folders, link each other with [[wikilinks]] (a few hubs get many links) and some carry Mermaid diagrams.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [out, n = '870', per = '5'] = process.argv.slice(2)
if (!out) (console.error('usage: node scripts/gen-vault.mjs <outDir> [notes] [linksPerNote]'), process.exit(1))
const N = Number(n)
const LINKS = Number(per)

let seed = 42
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pick = (k) => Math.floor(rnd() ** 2 * k) // skewed: low indexes are hubs

const names = Array.from({ length: N }, (_, i) => `Note ${String(i).padStart(4, '0')}`)
const dirs = ['Projects/Alpha', 'Projects/Beta', 'Areas/Health', 'Areas/Work', 'Resources/Books', 'Resources/Articles', 'Archive/2023', 'Archive/2024', 'Daily']
const mermaid = (i) => '```mermaid\nflowchart TD\n  A[Start ' + i + '] --> B{Check}\n  B -- yes --> C[Do it]\n  B -- no --> D[Skip]\n  C --> D\n```\n'

for (let i = 0; i < N; i++) {
  const dir = join(out, dirs[i % dirs.length])
  mkdirSync(dir, { recursive: true })
  const links = new Set()
  while (links.size < LINKS) {
    const j = pick(N)
    if (j !== i) links.add(names[j])
  }
  const body = [
    `---\ntags: [t${i % 17}, area/${i % 5}]\n---`,
    `# ${names[i]}`,
    'Lorem ipsum dolor sit amet, متن فارسی برای آزمایش و some English text. '.repeat(8),
    '## Links',
    ...[...links].map((l, k) => (k % 2 ? `- [[${l}]]` : `- [[${l}|alias ${k}]]`)),
    i % 12 === 0 ? mermaid(i) : '',
    i % 40 === 0 ? mermaid(i + 1) + mermaid(i + 2) : '',
    '#inline-tag',
  ].join('\n\n')
  writeFileSync(join(dir, names[i] + '.md'), body)
}
console.log(`wrote ${N} notes to ${out}`)
