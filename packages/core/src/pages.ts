// The `page` entity: registers title, parent, sortKey, trashed, kind, createdAt (ADR-0004). The body is a separate Yjs document with
// the same id (DocHandle). Reading the list is ONE bulk read of the registers.
import { generateKeyBetween } from 'fractional-indexing'
import type { Client } from './client'
import { KIND_FIELD } from './apply'
import type { Store } from './store'
import type { PageRow } from './tree'

export const PAGE_KIND = 'page'
const SUFFIX_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' // never '0': a fractional key must not end in the lowest digit

/** A sort key between two neighbours (either may be null = the end), with a random suffix so two devices inserting at the same
 *  spot at the same time get different keys (ADR-0004 §4). */
export function sortKeyBetween(before: string | null, after: string | null, rnd: () => number = Math.random): string {
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += SUFFIX_CHARS[Math.floor(rnd() * SUFFIX_CHARS.length)]
  return generateKeyBetween(before, after) + suffix
}

export interface NewPage { id?: string; title?: string; parent?: string; /** the sort keys of the neighbours it goes between */ before?: string | null; after?: string | null }

export async function createPage(client: Client, o: NewPage = {}, id: string = client.newIdFor()): Promise<string> {
  await client.setFields(id, { title: o.title ?? '', parent: o.parent ?? '', sortKey: sortKeyBetween(o.before ?? null, o.after ?? null), trashed: false, kind: 'doc', createdAt: client.nowMs() }, PAGE_KIND)
  return id
}
export const renamePage = (client: Client, id: string, title: string) => client.setFields(id, { title })
/** Moves a page: parent and sortKey travel in ONE op so that they win or lose together. */
export const movePage = (client: Client, id: string, parent: string, before: string | null, after: string | null) => client.setFields(id, { parent, sortKey: sortKeyBetween(before, after) })
export const trashPage = (client: Client, id: string) => client.setFields(id, { trashed: true })
export const restorePage = (client: Client, id: string) => client.setFields(id, { trashed: false })

const s = (v: string | undefined): string | undefined => (v === undefined ? undefined : (JSON.parse(v) as string))

/** All pages, from one bulk read of the registers. */
export async function readPages(store: Store): Promise<PageRow[]> {
  const all = await store.run(tx => tx.allFields())
  const by = new Map<string, Map<string, { val: string; hlc: string }>>()
  for (const r of all) {
    let m = by.get(r.ent)
    if (!m) by.set(r.ent, (m = new Map()))
    m.set(r.f, r)
  }
  const out: PageRow[] = []
  for (const [id, m] of by) {
    if (s(m.get(KIND_FIELD)?.val) !== PAGE_KIND) continue
    const get = (f: string) => m.get(f)?.val
    out.push({
      id,
      title: s(get('title')) ?? '',
      parent: s(get('parent')) ?? '',
      sortKey: s(get('sortKey')) ?? '',
      trashed: get('trashed') === 'true',
      kind: s(get('kind')) ?? 'doc',
      createdAt: Number(get('createdAt') ?? 0),
      parentHlc: m.get('parent')?.hlc ?? '',
    })
  }
  return out
}
