import type { Page } from './model.ts'
import type { DocumentOperationRecord } from './operations.ts'

/** Transient host proof, never part of a retry fingerprint or a retained operation record. */
export interface DocumentAdmission {
  check(pages: Page[], record: DocumentOperationRecord): void
  native?: { requestId: string; revision: string }
}
export function documentLinks(content: any, result = new Set<string>()): Set<string> {
  if (!content || typeof content !== 'object') return result
  if (content.type === 'pageLink' && typeof content.attrs?.id === 'string') result.add(content.attrs.id)
  if (Array.isArray(content.content)) content.content.forEach((child: unknown) => documentLinks(child, result))
  return result
}
