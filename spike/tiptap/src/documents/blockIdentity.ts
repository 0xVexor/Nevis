/** Document-scoped identity; independent of editor, storage and platform APIs. */
export const BLOCK_IDENTITY_VERSION = 1
export const BLOCK_TYPES = [
  'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'codeBlock', 'horizontalRule', 'table', 'tableRow',
  'tableCell', 'tableHeader', 'image', 'callout', 'toggle', 'mathBlock',
  'mermaid', 'drawing', 'databaseEmbed', 'layoutGroup', 'layoutColumn',
] as const
const blocks = new Set<string>(BLOCK_TYPES)
export const isBlockId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
export type IdentityNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: IdentityNode[]
  [key: string]: unknown
}
export function identityVersion(content: unknown): number {
  if (!content || typeof content !== 'object') return 0
  const version = (content as IdentityNode).attrs?.blockIdentityVersion
  return version === undefined ? 0 : typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : Infinity
}

/** Pure, repeatable migration/repair. Legacy IDs use document-local paths only on
 * first assignment; once stored they never depend on the block's current path.
 * A copy supplies a fresh allocator and replaces every supported block identity.
 */
export function identifyBlocks<T>(content: T, copyId?: () => string): { content: T; changed: boolean } {
  if (!content || typeof content !== 'object' || (content as unknown as IdentityNode).type !== 'doc') return { content, changed: false }
  if (identityVersion(content) > BLOCK_IDENTITY_VERSION) throw new Error('Unsupported block identity version')
  const root = content as unknown as IdentityNode
  const reserved = new Set<string>()
  const scan = (n: IdentityNode) => {
    if (blocks.has(n.type) && isBlockId(n.attrs?.blockId)) reserved.add(n.attrs.blockId)
    n.content?.forEach(scan)
  }
  scan(root)
  const seen = new Set<string>()
  let changed = false
  const fresh = (path: number[]) => {
    if (copyId) {
      for (let tries = 0; tries < 100; tries++) {
        const candidate = copyId()
        if (isBlockId(candidate) && !reserved.has(candidate) && !seen.has(candidate)) return candidate
      }
      throw new Error('Block identity allocator did not produce a fresh ID')
    }
    const base = `b1_${path.join('_')}`
    let candidate = base
    let suffix = 0
    while (reserved.has(candidate) || seen.has(candidate)) candidate = `${base}_${++suffix}`
    if (!isBlockId(candidate)) throw new Error('Block identity path is too deep')
    return candidate
  }
  const walk = (n: IdentityNode, path: number[]): IdentityNode => {
    let attrs = n.attrs
    if (blocks.has(n.type)) {
      const old = attrs?.blockId
      const id = !copyId && isBlockId(old) && !seen.has(old) ? old : fresh(path)
      seen.add(id)
      if (old !== id) { attrs = { ...attrs, blockId: id }; changed = true }
    }
    const children = n.content?.map((child, index) => walk(child, [...path, index]))
    const childChanged = children?.some((child, index) => child !== n.content![index])
    return attrs !== n.attrs || childChanged ? { ...n, ...(attrs ? { attrs } : {}), ...(children ? { content: children } : {}) } : n
  }
  let result = walk(root, [])
  if (identityVersion(root) !== BLOCK_IDENTITY_VERSION) {
    result = { ...result, attrs: { ...result.attrs, blockIdentityVersion: BLOCK_IDENTITY_VERSION } }
    changed = true
  }
  return { content: result as T, changed }
}
