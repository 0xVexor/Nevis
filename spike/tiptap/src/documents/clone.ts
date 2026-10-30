/** Clone page DTOs without depending on DOM/Node structuredClone. Page bodies,
 * metadata and extensions are JSON data; optional undefined fields are retained.
 * File handles and other platform objects live outside this document model. */
export function cloneDocumentValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneDocumentValue(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDocumentValue(item)])) as T
  }
  return value
}
