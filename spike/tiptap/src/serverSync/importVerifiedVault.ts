import type { Schema } from '@tiptap/pm/model'
import type { Page } from '../documents/model.ts'
import type { ImportScope } from './importCheckpoint.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'
import { assertVerifiedMigrationBackup } from './verifiedBackup.ts'
import { prepareVaultDocuments } from './prepareVault.ts'
import { prepareBackupAttachments } from './prepareAttachments.ts'
import { runPreparedImport } from './runPreparedImport.ts'

type Initializations = Parameters<typeof prepareVaultDocuments>[0]['initializations']
type Attempts = Parameters<typeof prepareBackupAttachments>[0]['attempts']
type Api = Parameters<typeof prepareBackupAttachments>[0]['api'] & Parameters<typeof runPreparedImport>[0]['api']
type Checkpoints = Parameters<typeof runPreparedImport>[0]['checkpoints']
type Bootstrap = Parameters<typeof runPreparedImport>[0]['bootstrap']

export class SourceChangedDuringImport extends Error {
  readonly remoteImportMayBeComplete: boolean
  constructor(remoteImportMayBeComplete: boolean) {
    super('Local vault changed during import; reconcile local changes before enabling sync')
    this.name = 'SourceChangedDuringImport'
    this.remoteImportMayBeComplete = remoteImportMayBeComplete
  }
}

/** Orchestrates a one-time import, not live sync. The host must flush drafts and
 * read the complete saved vault and attachment IDs on each source check. The
 * backup must be retained for retry. A successful return does not enable sync. */
export async function importVerifiedVault(input: {
  schema: Schema
  scope: ImportScope
  vaultName: string
  backup: VerifiedMigrationBackup
  initializations: Initializations
  attempts: Attempts
  checkpoints: Checkpoints
  api: Api
  bootstrap: Bootstrap
  loadCurrent: () => Promise<{ vaultId: string; pages: Page[]; attachmentIds: string[] }>
  send?: typeof fetch
  signal?: AbortSignal
  progress?: (phase: 'preparing' | 'attachments' | 'importing' | 'checking') => void
}): Promise<{ state: 'imported'; importId: string }> {
  const scope = structuredClone(input.scope), backup = input.backup, vaultName = input.vaultName
  const report = (phase: 'preparing' | 'attachments' | 'importing' | 'checking') => {
    if (input.signal?.aborted) throw new Error('Import cancelled')
    input.progress?.(phase)
  }
  const check = async (remoteMayBeComplete: boolean) => {
    if (input.signal?.aborted) throw new Error('Import cancelled')
    const current = await input.loadCurrent()
    try {
      if (current.vaultId !== scope.vaultId) throw new Error('Vault changed')
      assertVerifiedMigrationBackup(backup, current.vaultId, current.pages, current.attachmentIds)
    } catch { throw new SourceChangedDuringImport(remoteMayBeComplete) }
  }
  report('preparing')
  await check(false)
  const documents = await prepareVaultDocuments({ schema: input.schema, scope, backup, initializations: input.initializations })
  await check(false)
  report('attachments')
  const readyAttachments = await prepareBackupAttachments({ schema: input.schema, scope, vaultName, backup, documents, attempts: input.attempts, api: input.api, send: input.send, signal: input.signal })
  await check(false)
  report('importing')
  const result = await runPreparedImport({ schema: input.schema, scope, vaultName, backup, documents, readyAttachments, checkpoints: input.checkpoints, api: input.api, bootstrap: input.bootstrap, signal: input.signal })
  if (result.state !== 'complete' || !result.importId) throw new Error('Import did not complete')
  report('checking')
  await check(true)
  return { state: 'imported', importId: result.importId }
}
