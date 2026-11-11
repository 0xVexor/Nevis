import type { Schema } from '@tiptap/pm/model'
import * as Y from 'yjs'
import type { Page } from '../documents/model.ts'
import { canonicalDocumentValue } from '../documents/revision.ts'
import { planBackupAttachments } from './attachmentPlan.ts'
import { transferWithStoredAttempt } from './attachmentAttempts.ts'
import type { IndexedDbAttachmentAttemptStore } from './attachmentAttempts.ts'
import type { DocumentMutation } from './api.ts'
import { readInitialDocument } from './encodeInitialDocument.ts'
import { initialMetadata } from './initialMetadata.ts'
import { readVerifiedBackupAttachment } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'
import type { ImportScope } from './importCheckpoint.ts'

type TransferInput = Parameters<typeof transferWithStoredAttempt>[0]
type PreparationApi = TransferInput['api'] & {
  createVault(vaultId: string, name: string, signal?: AbortSignal): Promise<string>
  mutateDocument(vaultId: string, documentId: string, input: DocumentMutation, signal?: AbortSignal): Promise<unknown>
}

/** Complete known document-attachment references before freezing an import
 * manifest. Unassociated assets and unsupported payloads stop the workflow;
 * they cannot safely be attached to an arbitrary document. */
export async function prepareBackupAttachments(input: {
  schema: Schema
  scope: ImportScope
  vaultName: string
  backup: VerifiedMigrationBackup
  documents: { page: Page; initialUpdate: Uint8Array }[]
  attempts: Pick<IndexedDbAttachmentAttemptStore, 'current' | 'expired' | 'ready'>
  api: PreparationApi
  send?: typeof fetch
  signal?: AbortSignal
}): Promise<{ id: string; sha256: string; documentId: string }[]> {
  const scope = structuredClone(input.scope), vaultName = input.vaultName
  const documents = input.documents.map(item => ({ page: structuredClone(item.page), initialUpdate: new Uint8Array(item.initialUpdate) }))
  const pages = documents.map(item => item.page), plan = planBackupAttachments(input.backup, scope.vaultId, pages)
  if (plan.unreferenced.length) throw new Error('Unreferenced backup attachments require an archive')
  if (plan.unsupportedDocuments.length) throw new Error('Database or slide resources require migration support')
  const byId = new Map(pages.map(page => [page.id, page]))
  if (byId.size !== pages.length) throw new Error('Duplicate import document')
  for (const { page, initialUpdate } of documents) {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, initialUpdate)
      if (canonicalDocumentValue(readInitialDocument(doc, input.schema)) !== canonicalDocumentValue(page.content)) throw new Error('Initialization does not match source page')
    } finally { doc.destroy() }
  }
  for (const reference of plan.references)
    if (readVerifiedBackupAttachment(input.backup, scope.vaultId, reference.documentId, reference.sha256).byteLength > 64 * 1024 * 1024)
      throw new Error('Attachment exceeds the server limit')
  if (!plan.references.length) return []
  await input.api.verifyIdentity(scope.apiOrigin, scope.accountId, input.signal)
  await input.api.createVault(scope.vaultId, vaultName, input.signal)
  const created = new Set<string>(), ready: { id: string; sha256: string; documentId: string }[] = []
  for (const reference of plan.references) {
    if (!created.has(reference.documentId)) {
      await input.api.mutateDocument(scope.vaultId, reference.documentId, await initialMetadata(scope.vaultId, byId.get(reference.documentId)!), input.signal)
      created.add(reference.documentId)
    }
    const result = await transferWithStoredAttempt({ scope, backup: input.backup, documentId: reference.documentId, sha256: reference.sha256, api: input.api, send: input.send, signal: input.signal }, input.attempts)
    ready.push({ ...result, documentId: reference.documentId })
  }
  return ready
}
