import { Repo, WELCOME_DOC } from './repo'
import { isTauri, listVersions } from './db'
import { setPageTitleResolver } from './markdown'

export const repo = new Repo(() => [
  {
    id: crypto.randomUUID(),
    parentId: null,
    title: 'خوش آمدید',
    icon: 'i:hand',
    favorite: true,
    sort: 0,
    content: WELCOME_DOC,
    updatedAt: Date.now(),
    deletedAt: null,
  },
])

export const TRASH_DAYS = 30

/** Loads the workspace (migrating the old localStorage data once). Call before rendering. */
export async function initStore() {
  await repo.init()
  repo.autoPurge(TRASH_DAYS * 24 * 3600 * 1000)
}

/** Removes stored files that no page (including trash) references any more. */
export async function gcFiles() {
  const { fileIndex, deleteFile } = await import('./attachments')
  // a custom background image is referenced from the settings, not from a page
  // Desktop history can include deleted pages and pinned conflicts outside the
  // current page list. Until reachability is proven, retain their attachments.
  if (isTauri) return
  const pages = repo.dump()
  const history = await Promise.all(pages.map(p => listVersions(p.id)))
  const used = JSON.stringify(pages) + JSON.stringify(history) + (localStorage.getItem('not.settings') ?? '')
  const grace = Date.now() - 3600_000 // a just-pasted image may not be in a saved page yet (editor autosave, undo history)
  for (const f of await fileIndex()) if (!used.includes(f.id) && (f.addedAt ?? 0) < grace) await deleteFile(f.id)
}

setPageTitleResolver((id) => repo.get(id)?.title || id)
