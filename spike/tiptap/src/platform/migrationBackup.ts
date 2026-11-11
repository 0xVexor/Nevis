import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { isTauri, storageFrozen, vaultInfo } from '../db'
import { saveWorkspace } from '../saveWorkspace'
import { fileStamp } from '../backup/format'
import type { MigrationBackupPlatform } from '../serverSync/saveBackup'

/** Native commands verify the active vault while holding the host's vault lock. */
export function createMigrationBackupPlatform(): MigrationBackupPlatform {
  return {
    active: () => isTauri && !storageFrozen(),
    vaultId: async () => (await vaultInfo()).id,
    chooseSavePath: () => save({ defaultPath: `nevis-before-sync-${fileStamp()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] }),
    async chooseExistingPath() {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'JSON', extensions: ['json'] }] })
      return typeof path === 'string' ? path : null
    },
    flush: saveWorkspace,
    async saveAndRead(path, expectedVaultId) {
      return new Uint8Array(await invoke<ArrayBuffer>('vault_backup_for_sync', { path, expectedVaultId }))
    },
    async read(path, expectedVaultId) {
      return new Uint8Array(await invoke<ArrayBuffer>('vault_backup_read_for_sync', { path, expectedVaultId }))
    },
  }
}
