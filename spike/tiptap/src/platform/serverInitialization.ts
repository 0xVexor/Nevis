import { invoke } from '@tauri-apps/api/core'
import { storageFrozen } from '../db'
import { NativeInitializationStore } from '../serverSync/nativeInitializationStore'
import type { InitializationScope } from '../serverSync/initializationStore'

const args = (scope: InitializationScope) => ({
  expectedVaultId: scope.vaultId,
  accountId: scope.accountId,
  collaborationOrigin: scope.collaborationOrigin,
  documentId: scope.documentId,
})

export function createNativeInitializationStore(vaultId: string): NativeInitializationStore {
  return new NativeInitializationStore(vaultId, {
    active: () => !storageFrozen(),
    load: scope => invoke<number[] | null>('server_initialization_load', args(scope)),
    prepare: (scope, bytes, expectedPage) => invoke<number[]>('server_initialization_prepare', { ...args(scope), bytes, expectedPage }),
  })
}
