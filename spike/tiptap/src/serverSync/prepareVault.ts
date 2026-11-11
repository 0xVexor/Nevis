import type { Schema } from '@tiptap/pm/model'
import type { Page } from '../documents/model.ts'
import { prepareInitialDocument } from './encodeInitialDocument.ts'
import type { InitializationScope } from './initializationStore.ts'
import type { ImportScope } from './importCheckpoint.ts'
import { assertVerifiedMigrationBackup } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'

interface InitializationStore {
  load(scope: InitializationScope): Promise<Uint8Array | null>
  prepare(scope: InitializationScope, update: Uint8Array, expectedPage: Page): Promise<Uint8Array>
}

/** Prepare exact initialization bytes for all pages in the verified backup.
 * The storage implementation checks each expected page against the live vault. */
export async function prepareVaultDocuments(input: {
  schema: Schema
  scope: ImportScope
  backup: VerifiedMigrationBackup
  initializations: InitializationStore
}): Promise<{ page: Page; initialUpdate: Uint8Array }[]> {
  const scope = structuredClone(input.scope), pages = [...structuredClone(input.backup.pages)]
  assertVerifiedMigrationBackup(input.backup, scope.vaultId, pages, input.backup.attachmentIds)
  pages.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const result: { page: Page; initialUpdate: Uint8Array }[] = []
  for (const page of pages) {
    const binding = { vaultId: scope.vaultId, accountId: scope.accountId, collaborationOrigin: scope.collaborationOrigin, documentId: page.id }
    const initialUpdate = await prepareInitialDocument(input.schema, page, binding, input.initializations)
    result.push({ page, initialUpdate })
  }
  return result
}
