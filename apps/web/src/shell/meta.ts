import { normalizeForSearch } from '@nevis/text-fa'
import type { Page, PageStatus } from './model'

export const STATUS: Record<PageStatus, { label: string; color: string }> = {
  todo: { label: 'To do', color: '#9b9a97' },
  doing: { label: 'In progress', color: '#e9a23b' },
  done: { label: 'Done', color: '#4dab9a' },
}

const cleanTag = (t: string) => t.replace(/^#+/, '').replace(/\s+/g, ' ').trim()

/** Adds a tag unless an equivalent one (same letters after Persian normalisation) is already there. */
export function addTag(tags: string[], raw: string): string[] {
  const t = cleanTag(raw)
  if (!t || tags.some(x => normalizeForSearch(x) === normalizeForSearch(t))) return tags
  return [...tags, t]
}

export function allTags(pages: Page[]): string[] {
  const seen = new Map<string, string>()
  for (const p of pages) for (const t of p.tags ?? []) if (!seen.has(normalizeForSearch(t))) seen.set(normalizeForSearch(t), t)
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'fa'))
}

/** Words of a page: counted when the page was indexed. */
export const wordCount = (p: Pick<Page, 'words'>): number => p.words ?? 0
