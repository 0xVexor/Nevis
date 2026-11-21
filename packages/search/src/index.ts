// The search index (ADR-0010): MiniSearch with the shared Persian tokenizer. A DERIVED structure: built from the pages, kept on this
// device, never synced, rebuilt whenever `NORM_VERSION` (or the index format) changes.
import MiniSearch from 'minisearch'
import { NORM_VERSION, queryGroups, tokenize } from '@nevis/text-fa'

export interface SearchDoc { id: string; title: string; body: string; tags?: string }
export interface Hit { id: string; score: number }
/** The format of what `serialize` writes; changes with NORM_VERSION and with the fields below. */
export const INDEX_FORMAT = 1

const options = {
  idField: 'id',
  fields: ['title', 'body', 'tags'],
  storeFields: [] as string[],
  tokenize,
  processTerm: (t: string) => t, // `tokenize` already normalized
  searchOptions: { prefix: true, boost: { title: 3 }, combineWith: 'AND' as const, tokenize: (s: string) => [s] },
}

export class SearchIndex {
  private ms: MiniSearch<SearchDoc>
  constructor(ms?: MiniSearch<SearchDoc>) { this.ms = ms ?? new MiniSearch<SearchDoc>(options) }

  get size(): number { return this.ms.documentCount }
  has(id: string): boolean { return this.ms.has(id) }

  /** Adds or replaces a page. */
  set(doc: SearchDoc): void {
    if (this.ms.has(doc.id)) this.ms.replace({ tags: '', ...doc })
    else this.ms.add({ tags: '', ...doc })
  }
  /** Adds many pages (the first build). */
  addAll(docs: SearchDoc[]): void { this.ms.addAll(docs.map(d => ({ tags: '', ...d }))) }
  remove(id: string): void { if (this.ms.has(id)) this.ms.discard(id) }

  /** Pages matching every word of the query (as prefixes; a word with ZWNJ also by its parts), best first. */
  search(query: string, limit = 20): Hit[] {
    const groups = queryGroups(query)
    if (!groups.length) return []
    const q = {
      combineWith: 'AND' as const,
      queries: groups.map(alts => ({ combineWith: 'OR' as const, queries: alts.map(terms => ({ combineWith: 'AND' as const, queries: terms })) })),
    }
    return this.ms.search(q as never, { prefix: true, boost: { title: 3 }, tokenize: (s: string) => [s] }).slice(0, limit).map(r => ({ id: String(r.id), score: r.score }))
  }

  /** The index as text, tagged with the versions it was made under. */
  serialize(): string { return JSON.stringify({ norm: NORM_VERSION, format: INDEX_FORMAT, index: this.ms.toJSON() }) }

  /** Reads what `serialize` wrote; null when it was made under other versions or is damaged (the caller rebuilds). */
  static load(text: string): SearchIndex | null {
    try {
      const j = JSON.parse(text) as { norm: number; format: number; index: unknown }
      if (j.norm !== NORM_VERSION || j.format !== INDEX_FORMAT) return null
      return new SearchIndex(MiniSearch.loadJS<SearchDoc>(j.index as never, options))
    } catch { return null }
  }
}

export { NORM_VERSION }

export { extractPage, type Extracted, type PMNode, type PageLinkRef, type PageTask } from './extract'
