import { verifySavedMigrationBackup } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'

/** The native adapter must return the bytes read from disk only after comparing
 * them with the snapshot it wrote. Paths are chosen by the person using Nevis. */
export interface MigrationBackupPlatform {
  active(): boolean
  vaultId(): Promise<string>
  chooseSavePath(): Promise<string | null>
  chooseExistingPath(): Promise<string | null>
  flush(): Promise<void>
  saveAndRead(path: string, expectedVaultId: string): Promise<Uint8Array>
  read(path: string, expectedVaultId: string): Promise<Uint8Array>
}

async function assertVault(platform: MigrationBackupPlatform, expectedVaultId: string): Promise<void> {
  if (!expectedVaultId || !platform.active() || await platform.vaultId() !== expectedVaultId || !platform.active()) throw new Error('Backup vault unavailable')
}

export async function createMigrationBackup(platform: MigrationBackupPlatform, expectedVaultId: string): Promise<{ path: string; backup: VerifiedMigrationBackup } | null> {
  await assertVault(platform, expectedVaultId)
  const path = await platform.chooseSavePath()
  if (!path) return null
  await assertVault(platform, expectedVaultId)
  await platform.flush()
  await assertVault(platform, expectedVaultId)
  const saved = await platform.saveAndRead(path, expectedVaultId)
  await assertVault(platform, expectedVaultId)
  const backup = await verifySavedMigrationBackup(expectedVaultId, saved, saved)
  await assertVault(platform, expectedVaultId)
  return { path, backup }
}

/** On restart, independently re-read the selected file. The persisted import
 * checkpoint rejects it if its fingerprint differs from the original backup. */
export async function reopenMigrationBackup(platform: MigrationBackupPlatform, expectedVaultId: string): Promise<{ path: string; backup: VerifiedMigrationBackup } | null> {
  await assertVault(platform, expectedVaultId)
  const path = await platform.chooseExistingPath()
  if (!path) return null
  await assertVault(platform, expectedVaultId)
  const saved = await platform.read(path, expectedVaultId)
  await assertVault(platform, expectedVaultId)
  const backup = await verifySavedMigrationBackup(expectedVaultId, saved, saved)
  await assertVault(platform, expectedVaultId)
  return { path, backup }
}
