import type { Page } from './repo'

/** Children of every page (sorted) and the number of pages inside each one, built in one pass so the tree never re-filters the whole list per row. */
export interface PageIndex {
  kids: Map<string | null, Page[]>
  count: Map<string, number> // pages (not folders) anywhere below an id
}

export function buildIndex(pages: Page[]): PageIndex {
  const kids = new Map<string | null, Page[]>()
  for (const p of pages) {
    if (p.database) continue // database rows live inside their database, not in the page tree
    const key = p.parentId ?? null
    const list = kids.get(key)
    if (list) list.push(p)
    else kids.set(key, [p])
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort)

  const count = new Map<string, number>()
  const visiting = new Set<string>() // a corrupt parent loop must not recurse forever
  const total = (id: string): number => {
    const known = count.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let n = 0
    for (const c of kids.get(id) ?? []) n += (c.kind === 'folder' ? 0 : 1) + total(c.id)
    visiting.delete(id)
    count.set(id, n)
    return n
  }
  for (const p of pages) total(p.id)
  return { kids, count }
}
