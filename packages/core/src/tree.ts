// The page tree, as a pure function of the page rows (ADR-0004). Pure so that it is cheap to test and the same in every client.
//
// Rules:
//  - children are ordered by (sortKey, id);
//  - a page whose parent does not exist (yet) is shown at the root;
//  - merges can create a cycle (A under B on one device, B under A on another). The cycle is broken IN THE VIEW ONLY: the page of the
//    cycle whose `parent` register has the greatest HLC (the last move) goes to the root. The data is not changed;
//  - a trashed page hides its whole subtree; the trash lists the pages that were trashed themselves.
export interface PageRow {
  id: string
  title: string
  parent: string
  sortKey: string
  trashed: boolean
  kind: string
  createdAt: number
  /** HLC of the `parent` register: decides which page of a cycle goes to the root. */
  parentHlc: string
}

export interface PageNode { page: PageRow; children: PageNode[]; depth: number }
export interface PageTree {
  roots: PageNode[]
  byId: Map<string, PageNode>
  /** pages that were trashed themselves (not their hidden descendants), newest first by id */
  trash: PageRow[]
  /** effective parent ('' = root) after orphan and cycle handling, for every page */
  parentOf: Map<string, string>
}

const byOrder = (a: PageRow, b: PageRow) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function buildTree(pages: readonly PageRow[]): PageTree {
  const row = new Map<string, PageRow>()
  for (const p of pages) row.set(p.id, p)
  const parentOf = new Map<string, string>()
  for (const p of pages) parentOf.set(p.id, p.parent && p.parent !== p.id && row.has(p.parent) ? p.parent : '')

  // break cycles: each page has one parent, so cycles are disjoint and the result does not depend on the input order
  const state = new Map<string, 1 | 2>() // 1 = on the current walk, 2 = done
  for (const start of [...row.keys()].sort()) {
    if (state.get(start) === 2) continue
    const walk: string[] = []
    let cur = start
    while (cur !== '' && state.get(cur) !== 2) {
      if (state.get(cur) === 1) {
        const cycle = walk.slice(walk.indexOf(cur))
        let last = cycle[0]!
        for (const id of cycle) if (row.get(id)!.parentHlc > row.get(last)!.parentHlc) last = id
        parentOf.set(last, '')
        break
      }
      state.set(cur, 1)
      walk.push(cur)
      cur = parentOf.get(cur)!
    }
    for (const id of walk) state.set(id, 2)
  }

  const kids = new Map<string, PageRow[]>()
  for (const p of pages) {
    const par = parentOf.get(p.id)!
    let l = kids.get(par)
    if (!l) kids.set(par, (l = []))
    l.push(p)
  }
  for (const l of kids.values()) l.sort(byOrder)

  const byId = new Map<string, PageNode>()
  const build = (p: PageRow, depth: number): PageNode => {
    const node: PageNode = { page: p, children: [], depth }
    byId.set(p.id, node)
    for (const c of kids.get(p.id) ?? []) if (!c.trashed) node.children.push(build(c, depth + 1))
    return node
  }
  const roots = (kids.get('') ?? []).filter(p => !p.trashed).map(p => build(p, 0))
  const trash = pages.filter(p => p.trashed).sort((a, b) => (a.id < b.id ? 1 : -1))
  return { roots, byId, trash, parentOf }
}

/** Is `maybeDescendant` below `ancestor` in the tree? (to refuse moving a page into itself) */
export function isInside(tree: PageTree, ancestor: string, maybeDescendant: string): boolean {
  for (let cur = maybeDescendant, n = 0; cur !== '' && n < 100_000; cur = tree.parentOf.get(cur) ?? '', n++) if (cur === ancestor) return true
  return false
}
