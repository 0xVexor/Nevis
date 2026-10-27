import { cloneDocumentValue } from './clone.ts'
import { LEXICAL_PROJECTION_VERSION, PortableLexicalIndex, sourcePassage } from './lexicalSearch.ts'
import type { Page } from './model.ts'

export type SearchFreshness = 'fresh' | 'pending' | 'failed'
export type PreparedSearch = { state: 'fresh'; index: PortableLexicalIndex } | { state: 'pending' | 'failed'; index: null }
export interface SearchIndexRuntime {
  build?(pages: Page[]): PortableLexicalIndex | Promise<PortableLexicalIndex>
  yield?(): Promise<void>
}
export function canonicalSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}

/** Volatile, versioned cache. Source snapshots are authoritative even if an
 * event was missed; in-flight old builds can never publish after invalidation. */
export class ManagedLexicalIndex {
  private state: SearchFreshness = 'pending'
  private key: string | null = null
  private index: PortableLexicalIndex | null = null
  private generation = 0
  private running: Promise<PreparedSearch> | null = null
  private readonly runtime: SearchIndexRuntime
  private readonly changed: (state: SearchFreshness) => void
  constructor(runtime: SearchIndexRuntime = {}, changed: (state: SearchFreshness) => void = () => {}) {
    this.runtime = runtime; this.changed = changed
  }
  status() { return this.state }
  isCurrent(index: PortableLexicalIndex) { return this.state === 'fresh' && this.index === index }
  private update(state: SearchFreshness) {
    if (state === this.state) return
    this.state = state
    try { this.changed(state) } catch { /* observers cannot fail a durable write */ }
  }
  invalidate() { this.generation++; this.key = null; this.index = null; this.running = null; this.update('pending') }
  failed(): PreparedSearch { this.invalidate(); this.update('failed'); return { state: 'failed', index: null } }
  prepare(pages: Page[], snapshot: string, version = LEXICAL_PROJECTION_VERSION): Promise<PreparedSearch> {
    const key = `${version}:${snapshot}`
    if (key === this.key && this.index && this.state === 'fresh') return Promise.resolve({ state: 'fresh', index: this.index })
    if (key === this.key && this.running) return this.running
    const generation = ++this.generation
    this.key = key; this.index = null; this.update('pending')
    const detached = cloneDocumentValue(pages)
    this.running = (async (): Promise<PreparedSearch> => {
      try {
        await this.runtime.yield?.()
        if (generation !== this.generation) return { state: 'pending', index: null }
        const index = await (this.runtime.build?.(detached) ?? new PortableLexicalIndex(detached))
        if (generation !== this.generation) return { state: 'pending', index: null }
        this.index = index; this.update('fresh')
        return { state: 'fresh', index }
      } catch {
        if (generation !== this.generation) return { state: 'pending', index: null }
        this.update('failed')
        return { state: 'failed', index: null }
      } finally { if (generation === this.generation) this.running = null }
    })()
    return this.running
  }
}

export class SearchIndexUnavailable extends Error {
  readonly state: 'pending' | 'failed'
  constructor(state: 'pending' | 'failed') { super('Search index is ' + state); this.state = state }
}

/** UI-only transient passages are never written back into the page store. */
export function rankedSearchPages(index: PortableLexicalIndex, pages: Page[], query: string): (Page & { searchPassage: string })[] {
  const matches = index.search(query, 'keywords')
  const byId = new Map(pages.map(page => [page.id, page])), seen = new Set<string>()
  return matches.flatMap(hit => {
    const page = byId.get(hit.documentId)
    if (!page || seen.has(page.id)) return []
    seen.add(page.id)
    const body = matches.find(match => match.documentId === page.id && match.source === 'body') ?? hit
    return [{ ...page, searchPassage: sourcePassage(body, 512) ?? '' }]
  })
}
