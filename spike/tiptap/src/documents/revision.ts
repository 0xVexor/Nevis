import type { Page } from './model.ts'

/** Canonicalize the complete persisted page, including metadata and content. */
export const canonicalDocumentValue = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

export async function documentRevision(page: Page, digest: (snapshot: string) => Promise<string>): Promise<string> {
  const hash = await digest(canonicalDocumentValue(page))
  if (!/^[a-f0-9]{64,128}$/i.test(hash)) throw new Error('Invalid document revision digest')
  return `r1:${hash}`
}
