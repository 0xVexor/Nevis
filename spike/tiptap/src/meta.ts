import type { Page, PageStatus } from './repo'
import { normalizeFa } from './normalize'

export const STATUS: Record<PageStatus, { label: string; color: string }> = {
  todo: { label: 'To do', color: '#9b9a97' },
  doing: { label: 'In progress', color: '#e9a23b' },
  done: { label: 'Done', color: '#4dab9a' },
}

/** "#  جاوا  " -> "جاوا"; empty string when nothing is left. */
const cleanTag = (t: string) => t.replace(/^#+/, '').replace(/\s+/g, ' ').trim()

/** Adds a tag unless an equivalent one (same letters after Persian normalisation) is already there. */
export function addTag(tags: string[], raw: string): string[] {
  const t = cleanTag(raw)
  if (!t || tags.some((x) => normalizeFa(x) === normalizeFa(t))) return tags
  return [...tags, t]
}

export function allTags(pages: Page[]): string[] {
  const seen = new Map<string, string>()
  for (const p of pages) for (const t of p.tags ?? []) if (!seen.has(normalizeFa(t))) seen.set(normalizeFa(t), t)
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'fa'))
}

const textOf = (n: any): string => (!n || typeof n === 'string' ? '' : n.text ?? (n.content ?? []).map(textOf).join(' '))

export function wordCount(content: any): number {
  const t = textOf(content).trim()
  return t ? t.split(/\s+/).length : 0
}

/** YAML header for exported Markdown; empty when the page has no metadata. */
export function frontMatter(p: Pick<Page, 'tags' | 'status'>): string {
  const lines: string[] = []
  if (p.tags?.length) lines.push(`tags: [${p.tags.map((t) => JSON.stringify(t)).join(', ')}]`)
  if (p.status) lines.push(`status: ${p.status}`)
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''
}
