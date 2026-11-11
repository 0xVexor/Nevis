import type { Schema } from '@tiptap/pm/model'
import * as Y from 'yjs'
import type { Page } from '../documents/model.ts'
import { canonicalDocumentValue } from '../documents/revision.ts'
import { readInitialDocument } from './encodeInitialDocument.ts'
import { assertSameImport, buildImportManifest } from './importManifest.ts'
import { startOrResumeImport } from './resumeImport.ts'
import type { Checkpoints, ImportApi } from './resumeImport.ts'
import type { DocumentMutation } from './api.ts'
import type { ImportCheckpoint, ImportScope } from './importCheckpoint.ts'
import { assertVerifiedMigrationBackup } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'
import { initialMetadata } from './initialMetadata.ts'
import { planBackupAttachments } from './attachmentPlan.ts'

interface PreparedDocument { page: Page; initialUpdate: Uint8Array }
interface ReadyAttachment { id: string; sha256: string; documentId: string }
interface RunnerApi extends ImportApi {
  createVault(vaultId: string, name: string, signal?: AbortSignal): Promise<string>
  mutateDocument(vaultId: string, documentId: string, input: DocumentMutation, signal?: AbortSignal): Promise<unknown>
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Run an import from a previously verified backup and retained initial updates.
 * Attachments supplied here must already have completed upload and durable IDs.
 * The server checks their readiness before acknowledging import completion.
 * The caller must retain the backup and source snapshot for subsequent retries. */
export async function runPreparedImport(input: {
  schema: Schema
  scope: ImportScope
  vaultName: string
  backup: VerifiedMigrationBackup
  documents: PreparedDocument[]
  readyAttachments: ReadyAttachment[]
  archive?: { id: string; sha256: string }
  checkpoints: Checkpoints
  api: RunnerApi
  bootstrap: (scope: ImportScope, documentId: string, initialUpdate: Uint8Array, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}): Promise<ImportCheckpoint> {
  const scope = structuredClone(input.scope)
  const vaultName = input.vaultName, backupSha256 = input.backup.sha256
  const documents = input.documents.map(row => ({ page: structuredClone(row.page), initialUpdate: new Uint8Array(row.initialUpdate) }))
    .sort((a, b) => a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0)
  const readyAttachments = structuredClone(input.readyAttachments), archive = input.archive && structuredClone(input.archive)
  const pages = documents.map(document => document.page)
  assertVerifiedMigrationBackup(input.backup, scope.vaultId, pages, readyAttachments.map(attachment => attachment.sha256))
  const plan = planBackupAttachments(input.backup, scope.vaultId, pages)
  if (plan.unreferenced.length || plan.unsupportedDocuments.length) throw new Error('Backup resources require additional migration support')
  const associations = readyAttachments.map(({ documentId, sha256 }) => ({ documentId, sha256 }))
    .sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)
  if (canonicalDocumentValue(associations) !== canonicalDocumentValue(plan.references)) throw new Error('Import attachment associations do not match backup')
  // Check every update before any remote mutation; an old or corrupt update may
  // not be paired with newer page metadata and presented as an imported page.
  for (const { page, initialUpdate } of documents) {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, initialUpdate)
      if (canonicalDocumentValue(readInitialDocument(doc, input.schema)) !== canonicalDocumentValue(page.content))
        throw new Error('Initialization does not match source page')
    } finally { doc.destroy() }
  }
  const manifest = await buildImportManifest(documents.map(({ page, initialUpdate }) => ({ id: page.id, initialUpdate })), readyAttachments, archive)
  const sourceSha256 = await digest(canonicalDocumentValue({ vaultName, pages }))
  await input.api.verifyIdentity(scope.apiOrigin, scope.accountId, input.signal)
  // Retain the source digest and manifest before creating anything remotely.
  await input.checkpoints.prepare(scope, backupSha256, sourceSha256, manifest)
  await input.api.createVault(scope.vaultId, vaultName, input.signal)
  const checkpoint = await startOrResumeImport(scope, backupSha256, sourceSha256, manifest, input.checkpoints, input.api, input.signal)
  if (checkpoint.state === 'complete') return checkpoint
  if (!checkpoint.importId) throw new Error('Import checkpoint missing ID')
  const status = await input.api.importStatus(scope.vaultId, input.signal)
  if (status.id !== checkpoint.importId) throw new Error('Import ID mismatch')
  assertSameImport(manifest, status.manifest)
  if (status.status === 'uploading') {
    for (const { page, initialUpdate } of documents) {
      await input.api.mutateDocument(scope.vaultId, page.id, await initialMetadata(scope.vaultId, page), input.signal)
      await input.bootstrap(scope, page.id, initialUpdate, input.signal)
    }
    // The server checks that every initial state and attachment is present.
    await input.api.completeImport(scope.vaultId, input.signal)
  }
  // Import completion requires live documents. Reapply the original tombstones
  // afterwards using stable keys, then mark the local checkpoint complete.
  for (const { page } of documents) {
    if (page.deletedAt === null) continue
    const { content: _content, ...metadata } = page
    const body = { expected_revision: 1, metadata, deleted: true }
    const key = `t_${await digest(canonicalDocumentValue({ vaultId: scope.vaultId, documentId: page.id, body }))}`
    await input.api.mutateDocument(scope.vaultId, page.id, { key, ...body }, input.signal)
  }
  return input.checkpoints.completed(scope, checkpoint.importId)
}
