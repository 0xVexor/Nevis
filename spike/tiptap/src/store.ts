import { Repo } from './repo'
import { setPageTitleResolver } from './markdown'

// A new workspace starts empty: Home then opens on the first-note sheet, ready to write.
export const repo = new Repo(() => [])

export const TRASH_DAYS = 7

/** Loads the workspace (migrating the old localStorage data once). Call before rendering. */
export async function initStore() {
  await repo.init()
  repo.autoPurge(TRASH_DAYS * 24 * 3600 * 1000)
}

/** Removes stored files that no page (including trash) references any more. */
export async function gcFiles() {
  // Conservative retention: assets may be referenced by database records, local history,
  // conflict preimages, or a pending publication. Collection waits for a complete reference index.
}

setPageTitleResolver((id) => repo.get(id)?.title || id)
