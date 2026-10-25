// Dev only: `?bench=870` fills the (browser) database with a synthetic vault so performance can be measured without importing files.
// Pages sit in nested folders, link each other (a few hubs get many links) and some contain Mermaid diagrams. Reload without the parameter to keep it.
import { savePages } from './db'

const DIRS = ['Projects/Alpha', 'Projects/Beta', 'Areas/Health', 'Areas/Work', 'Resources/Books', 'Resources/Articles', 'Archive/2023', 'Archive/2024', 'Daily']
const FLOW = (i: number) => `flowchart TD\n  A[Start ${i}] --> B{Check}\n  B -- yes --> C[Do it]\n  B -- no --> D[Skip]\n  C --> D`

export async function seedBench(n: number, links = 5) {
  let seed = 42
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const now = Date.now()
  const rows: any[] = []
  const folder = new Map<string, string>()
  const folderFor = (path: string[]): string | null => {
    if (!path.length) return null
    const key = path.join('/')
    let id = folder.get(key)
    if (!id) {
      id = crypto.randomUUID()
      folder.set(key, id)
      rows.push({ id, parentId: folderFor(path.slice(0, -1)), kind: 'folder', title: path.at(-1), favorite: false, sort: folder.size, content: null, updatedAt: now, deletedAt: null })
    }
    return id
  }
  const ids = Array.from({ length: n }, () => crypto.randomUUID())
  for (let i = 0; i < n; i++) {
    const targets = new Set<number>()
    while (targets.size < Math.min(links, n - 1)) {
      // most links go to neighbours (same topic), a quarter to a few hub pages, like a real vault
      const j = rnd() < 0.75 ? Math.min(n - 1, Math.max(0, i + Math.round((rnd() - 0.5) * 30))) : Math.floor(rnd() ** 3 * n)
      if (j !== i) targets.add(j)
    }
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const content = [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `Note ${i}` }] },
      para('Lorem ipsum dolor sit amet, متن فارسی برای آزمایش و some English text. '.repeat(8)),
      { type: 'paragraph', content: [...targets].flatMap((j) => [{ type: 'pageLink', attrs: { id: ids[j], label: null } }, { type: 'text', text: ' ' }]) },
      ...(i % 12 === 0 ? [{ type: 'mermaid', attrs: { code: FLOW(i) } }] : []),
      ...(i % 40 === 0 ? [{ type: 'mermaid', attrs: { code: 'flowchart TD\n  A --> B\n  E[Decrement numbers[left]] --> F{\n  F --> G' } }] : []), // invalid on purpose
      ...(i % 40 === 0 ? [{ type: 'mermaid', attrs: { code: FLOW(i + 1) } }, { type: 'mermaid', attrs: { code: FLOW(i + 2) } }] : []),
    ]
    rows.push({
      id: ids[i],
      parentId: folderFor(['Vault', ...DIRS[i % DIRS.length].split('/')]),
      title: `Note ${String(i).padStart(4, '0')}`,
      tags: [`t${i % 17}`],
      favorite: false,
      sort: i,
      content: { type: 'doc', content },
      updatedAt: now - i * 1000,
      deletedAt: null,
    })
  }
  await savePages(rows, [], true)
  return rows.length
}
