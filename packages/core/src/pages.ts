// The `page` entity: registers title, parent, sortKey, trashed, kind, createdAt (ADR-0004). The body is a separate Yjs document with
// the same id (DocHandle). Reading the list is ONE bulk read of the registers.
import { sortKeyBetween } from './sortKey'
import type { Client } from './client'
import { readStructured } from './records'
import type { Store } from './store'
import type { PageRow } from './tree'

export const PAGE_KIND = 'page'
export { sortKeyBetween }
export interface NewPage { id?: string; title?: string; parent?: string; /** the sort keys of the neighbours it goes between */ before?: string | null; after?: string | null }

export async function createPage(client: Client, o: NewPage = {}, id: string = client.newIdFor()): Promise<string> {
  await client.setFields(id, { title: o.title ?? '', parent: o.parent ?? '', sortKey: sortKeyBetween(o.before ?? null, o.after ?? null, client.rnd), trashed: false, kind: 'doc', createdAt: client.nowMs() }, PAGE_KIND)
  return id
}
export const renamePage = (client: Client, id: string, title: string) => client.setFields(id, { title })
/** Moves a page: parent and sortKey travel in ONE op so that they win or lose together. */
export const movePage = (client: Client, id: string, parent: string, before: string | null, after: string | null) => client.setFields(id, { parent, sortKey: sortKeyBetween(before, after, client.rnd) })
/** Metadata of a page, each its own register (concurrent edits of different ones both survive). */
export const setPageMeta = (client: Client, id: string, patch: { icon?: string; status?: string; favorite?: boolean; cover?: string | null }) =>
  client.setFields(id, { ...(patch.icon !== undefined ? { icon: patch.icon } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}), ...(patch.cover !== undefined ? { cover: patch.cover === null ? '' : JSON.parse(patch.cover) } : {}) })
/** Moves a page to the trash and remembers WHEN (one op: both fields), so the trash can say how long a page has been there. */
export const trashPage = (client: Client, id: string) => client.setFields(id, { trashed: true, trashedAt: client.nowMs() })
export const restorePage = (client: Client, id: string) => client.setFields(id, { trashed: false, trashedAt: null })

const s = (v: string | undefined): string | undefined => (v === undefined ? undefined : (JSON.parse(v) as string))

/** All pages and databases (the nodes of the page tree), from one bulk read of the registers. */
export async function readPages(store: Store): Promise<PageRow[]> {
  return (await readStructured(store)).pages
}
