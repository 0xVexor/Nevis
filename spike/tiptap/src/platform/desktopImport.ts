import { invoke } from '@tauri-apps/api/core'
import { getSchema } from '@tiptap/core'
import { allPages, db, isTauri, storageFrozen, vaultInfo } from '../db'
import { extensions } from '../editor/extensions'
import { saveWorkspace } from '../saveWorkspace'
import { NevisServerApi } from '../serverSync/api'
import { IndexedDbAttachmentAttemptStore } from '../serverSync/attachmentAttempts'
import { bootstrapDocument } from '../serverSync/bootstrap'
import { bindTransportToVault } from '../serverSync/boundTransport'
import { IndexedDbImportCheckpointStore } from '../serverSync/importCheckpoint'
import type { ImportScope } from '../serverSync/importCheckpoint'
import { importVerifiedVault } from '../serverSync/importVerifiedVault'
import type { VerifiedMigrationBackup } from '../serverSync/verifiedBackup'
import { createNativeInitializationStore } from './serverInitialization'

/** Desktop host for the one-time import. The caller must supply an authenticated
 * transport that can reach the API, collaboration service, and object store.
 * This does not activate live sync or persist the device credential. */
export async function importDesktopBackup(input: {
  scope: ImportScope
  vaultName: string
  backup: VerifiedMigrationBackup
  sessionToken: string
  transport: typeof fetch
  signal?: AbortSignal
  progress?: Parameters<typeof importVerifiedVault>[0]['progress']
}): Promise<{ state: 'imported'; importId: string }> {
  const scope = structuredClone(input.scope), token = input.sessionToken, transport = input.transport
  const active = () => isTauri && !storageFrozen() && !input.signal?.aborted
  const assertVault = async () => {
    if (!active() || (await vaultInfo()).id !== scope.vaultId || !active()) throw new Error('Import vault unavailable')
  }
  await assertVault()
  const send = bindTransportToVault(transport, assertVault)
  const api = new NevisServerApi(scope.apiOrigin, token, send)
  return importVerifiedVault({
    schema: getSchema(extensions), scope, vaultName: input.vaultName, backup: input.backup,
    initializations: createNativeInitializationStore(scope.vaultId),
    attempts: new IndexedDbAttachmentAttemptStore(scope.vaultId, db, active),
    checkpoints: new IndexedDbImportCheckpointStore(scope.vaultId, db, active),
    api, send, signal: input.signal, progress: input.progress,
    bootstrap: (bound, documentId, initialUpdate, signal) => bootstrapDocument({
      collaborationOrigin: bound.collaborationOrigin, documentId, initialUpdate, sessionToken: token, signal,
    }, send),
    async loadCurrent() {
      await assertVault()
      await saveWorkspace()
      await assertVault()
      const pages = await allPages()
      const files = await invoke<{ id: string }[]>('files_list')
      await assertVault()
      if (!Array.isArray(files) || files.some(file => !/^[a-f0-9]{64}$/.test(file.id)) || new Set(files.map(file => file.id)).size !== files.length)
        throw new Error('Invalid local attachment listing')
      return { vaultId: scope.vaultId, pages, attachmentIds: files.map(file => file.id) }
    },
  })
}
