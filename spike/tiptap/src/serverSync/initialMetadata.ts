import type { Page } from '../documents/model.ts'
import { canonicalDocumentValue } from '../documents/revision.ts'
import type { DocumentMutation } from './api.ts'

/** Identical keys let attachment preparation and import replay the same create. */
export async function initialMetadata(vaultId: string, page: Page): Promise<DocumentMutation> {
  const { content: _content, ...metadata } = structuredClone(page)
  const body = { expected_revision: 0, metadata, deleted: false }
  const identity = canonicalDocumentValue({ vaultId, documentId: page.id, body })
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  const key = `i_${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`
  return { key, ...body }
}
