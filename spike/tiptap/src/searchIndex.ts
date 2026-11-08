// UI adapter for the same portable lexical engine used by scoped document reads.
import { storageFrozen } from './db'
import { SearchIndexUnavailable } from './documents/searchLifecycle'
import { repo } from './store'
import type { Page } from './repo'

export async function searchPages(query: string): Promise<Page[]> {
  if (!query.trim()) return []
  if (storageFrozen()) throw new SearchIndexUnavailable('failed')
  const pages = await repo.searchPersisted(query)
  if (storageFrozen()) throw new SearchIndexUnavailable('failed')
  return pages.slice(0, 50)
}
