// UI adapter for the same portable lexical engine used by scoped document reads.
// Legacy SQLite FTS files are ignored; volatile projections reconcile on startup
// and every query, with version/content keys rather than timestamp-only reuse.
import { storageFrozen } from './db'
import { SearchIndexUnavailable } from './documents/searchLifecycle'
import { repo } from './store'
import type { Page } from './repo'

let timer = 0
let initialized = false
export function initSearchIndex() {
  if (initialized) return
  initialized = true
  const warm = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (!storageFrozen()) void repo.refreshSearchIndex() }, 0)
  }
  window.addEventListener('data-changed', warm)
  window.addEventListener('external-change', warm)
  warm()
}

export async function searchPages(query: string): Promise<Page[]> {
  if (!query.trim()) return []
  if (storageFrozen()) throw new SearchIndexUnavailable('failed')
  const pages = await repo.searchPersisted(query)
  if (storageFrozen()) throw new SearchIndexUnavailable('failed')
  return pages.slice(0, 50)
}
