import { assertSameImport } from './importManifest.ts'
import type { ImportManifest } from './api.ts'
import type { ImportCheckpoint, ImportScope } from './importCheckpoint.ts'

export interface Checkpoints {
  prepare(scope: ImportScope, backupSha256: string, sourceSha256: string, manifest: ImportManifest): Promise<ImportCheckpoint>
  started(scope: ImportScope, importId: string): Promise<ImportCheckpoint>
  completed(scope: ImportScope, importId: string): Promise<ImportCheckpoint>
}
export interface ImportApi {
  verifyIdentity(origin: string, accountId: string, signal?: AbortSignal): Promise<void>
  beginImport(vaultId: string, manifest: ImportManifest, signal?: AbortSignal): Promise<string>
  importStatus(vaultId: string, signal?: AbortSignal): Promise<{ id: string; status: 'uploading' | 'complete'; manifest: ImportManifest }>
  completeImport(vaultId: string, signal?: AbortSignal): Promise<void>
}

/** Call only after the backup has been written and independently verified, and
 * after document bytes and attachment IDs are durably retained. The caller
 * verifies that the API client is authenticated for the scope's account/origin. */
export async function startOrResumeImport(
  scopeInput: ImportScope, backupSha256: string, sourceSha256: string, manifestInput: ImportManifest, checkpoints: Checkpoints, api: ImportApi, signal?: AbortSignal,
): Promise<ImportCheckpoint> {
  const scope = structuredClone(scopeInput), manifest = structuredClone(manifestInput)
  await api.verifyIdentity(scope.apiOrigin, scope.accountId, signal)
  let checkpoint = await checkpoints.prepare(scope, backupSha256, sourceSha256, manifest)
  if (checkpoint.state === 'prepared') {
    // If the response is lost, the server accepts the identical manifest again.
    const importId = await api.beginImport(scope.vaultId, checkpoint.manifest, signal)
    checkpoint = await checkpoints.started(scope, importId)
  }
  const status = await api.importStatus(scope.vaultId, signal)
  if (status.id !== checkpoint.importId) throw new Error('Import ID mismatch')
  assertSameImport(checkpoint.manifest, status.manifest)
  if (checkpoint.state === 'complete' && status.status !== 'complete') throw new Error('Remote import no longer complete')
  // A completed server manifest is not the same as finished local migration:
  // deletion reconciliation may still need to run after server completion.
  return checkpoint
}
