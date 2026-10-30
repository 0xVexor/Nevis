import type { Page } from './model.ts'
import { validateOperationRecord } from './operations.ts'
import type { DocumentOperationRecord } from './operations.ts'
import { canonicalDocumentValue } from './revision.ts'

/** Transient host proof, never part of a retry fingerprint or a retained operation record. */
export interface DocumentAdmission {
  check(pages: Page[], record: DocumentOperationRecord, undoOrigin?: DocumentOperationRecord | null): void
  native?: { requestId: string; revision: string }
}
export function documentLinks(content: any, result = new Set<string>()): Set<string> {
  if (!content || typeof content !== 'object') return result
  if (content.type === 'pageLink' && typeof content.attrs?.id === 'string') result.add(content.attrs.id)
  if (Array.isArray(content.content)) content.content.forEach((child: unknown) => documentLinks(child, result))
  return result
}

/** Resource IDs are shareable only through a currently readable document. Knowing
 * a content hash or database ID alone must not let a client expose private data. */
export function documentResources(page: Partial<Page> | null, result = new Set<string>()): Set<string> {
  if (!page) return result
  if (page.cover?.kind === 'image') result.add(`attachment:${page.cover.file}`)
  if (typeof page.dbHost === 'string') result.add(`database:${page.dbHost}`)
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    const attrs = node.attrs ?? {}
    if (node.type === 'image' && typeof attrs.src === 'string' && attrs.src.startsWith('att:')) result.add(`attachment:${attrs.src.slice(4)}`)
    if (node.type === 'drawing') for (const key of ['scene', 'preview']) if (typeof attrs[key] === 'string' && attrs[key]) result.add(`attachment:${attrs[key]}`)
    if (node.type === 'databaseEmbed' && typeof attrs.containerId === 'string') result.add(`database:${attrs.containerId}`)
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(page.content)
  return result
}
export function canUseDocumentResource(pages: Page[], canRead: (id: string) => boolean, kind: 'attachment' | 'database', id: string) {
  return pages.some(page => page.deletedAt === null && canRead(page.id) && documentResources(page).has(`${kind}:${id}`))
}

/** Only the storage adapter can supply the committed origin of an exact undo. */
export function undoResources(record: DocumentOperationRecord, origin?: DocumentOperationRecord | null): Set<string> {
  if (!origin || !record.undoOf || origin.operationId !== record.undoOf || origin.scopeId !== record.scopeId || origin.after.id !== record.after.id || !origin.before) return new Set()
  validateOperationRecord(origin)
  if (canonicalDocumentValue(origin.before.content) !== canonicalDocumentValue(record.after.content)
    || canonicalDocumentValue(origin.before.cover ?? null) !== canonicalDocumentValue(record.after.cover ?? null)) return new Set()
  return documentResources(origin.before)
}
