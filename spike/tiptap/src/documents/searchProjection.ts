import { normalizeFa } from './normalize.ts'

export interface SearchPage {
  id: string
  title: string
  tags?: readonly string[]
  content: unknown
  updatedAt: number
}

export interface SearchDocument {
  id: string
  updated: number
  title: string
  tags: string
  body: string
}

/** Preserve the current index projection while separating it from platform APIs.
 * Attribute-only formulas, diagrams and link labels need a versioned projection
 * change and index rebuild in the retrieval milestone; this extraction changes neither.
 */
export function documentText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: unknown; content?: unknown }
  if (typeof node.text === 'string') return node.text
  return Array.isArray(node.content) ? node.content.map(documentText).join(' ') : ''
}

export function searchWords(query: string): string[] {
  return normalizeFa(query).split(/\s+/).filter(Boolean)
}

export function projectSearchDocument(page: SearchPage): SearchDocument {
  return {
    id: page.id,
    updated: page.updatedAt,
    title: normalizeFa(page.title),
    tags: normalizeFa((page.tags ?? []).join(' ')),
    body: normalizeFa(documentText(page.content)),
  }
}
