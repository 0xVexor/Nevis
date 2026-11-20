// The calls the settings page makes to the app's sync. Desktop only: the browser version has no sync.
// Errors arrive as the backend's codes (`AUTH:unauthorized`, `HUB:username_taken`, `NETWORK:...`); `syncError` makes text of them.
import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'
import { explain } from '../vaultErrors'
import { codeMessage } from './syncErrorText'

export type SyncState = 'off' | 'idle' | 'pending' | 'syncing' | 'paused' | 'error' | 'offline'

export interface SyncStatus {
  signedIn: boolean
  username: string | null
  server: string
  defaultServer: string
  /** sync is switched on for the open workspace */
  syncOn: boolean
  state: SyncState
  lastAt: number
  error: string
  /** code of the first error of the last round (`HUB:quota_exceeded`, `NETWORK:…`); '' when none. Absent in older backends. */
  errorCode?: string
  /** the path the first error concerns; '' when none */
  errorPath?: string
  /** why it is paused: SIGNED_OUT | NEEDS_CONFIRM (then `error` is the number of held deletions) | VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE | VAULT_TAKEN | ACCOUNT_CHANGED (then `error` is the `user@server` the workspace syncs with) */
  reason: string
  /** id of the open workspace (null when none is open) */
  vaultId?: string | null
  /** names the sync cannot carry (it leaves those files alone) */
  skippedPaths?: string[]
}

/** A deletion the sync holds back until the person confirms it. `side`: where the file is gone. `base_md5` binds the confirmation to what was shown. */
export interface HeldDelete {
  path: string
  side: 'local' | 'remote'
  base_md5: string
}

export interface ServerHealth {
  name?: string
  /** open | invite | closed */
  registration?: string
}

export interface Device {
  id: string
  name: string
  last_seen?: number | null
  current?: boolean
}

export interface AccountInfo {
  user?: { username?: string }
  devices?: Device[]
  quota?: { used?: number; limit?: number }
  vaults?: number
}

export interface ServerVault {
  id: string
  name: string
  files?: number
  bytes?: number
}

export interface TrashedVault extends ServerVault {
  /** when it went to the server's trash (seconds since the epoch) */
  deletedAt?: number | null
}

export const accountStatus = () => invoke<SyncStatus>('account_status')
export const serverHealth = (server: string) => invoke<ServerHealth>('server_health', { server })
export const accountRegister = (server: string, username: string, password: string, invite: string) => invoke<string>('account_register', { server, username, password, invite })
export const accountLogin = (server: string, username: string, password: string) => invoke<void>('account_login', { server, username, password })
export const accountRecover = (server: string, username: string, recoveryKey: string, newPassword: string) => invoke<string>('account_recover', { server, username, recoveryKey, newPassword })
export const accountLogout = () => invoke<void>('account_logout')
export const accountInfo = () => invoke<AccountInfo>('account_info')
export const accountRevokeDevice = (id: string) => invoke<void>('account_revoke_device', { id })
export const accountChangePassword = (oldPassword: string, newPassword: string) => invoke<void>('account_change_password', { oldPassword, newPassword })
export const accountNewRecoveryKey = (password: string) => invoke<string>('account_new_recovery_key', { password })
export const saveTextFile = (path: string, text: string) => invoke<void>('save_text_file', { path, text })
/** Asks where to save the recovery key and writes it there. False when the person closed the dialog. */
export async function saveRecoveryKeyFile(username: string, keyText: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({ defaultPath: 'nevis-recovery-key.txt', filters: [{ name: 'TXT', extensions: ['txt'] }] })
  if (!path) return false
  await saveTextFile(path, `Nevis recovery key\nUser: ${username}\nKey: ${keyText}\n`)
  return true
}
export const syncSet = (on: boolean) => invoke<void>('sync_set', { on })
/** The server copy of the open workspace is gone: sends the local files to the server again and keeps syncing. */
export const syncReupload = () => invoke<void>('sync_reupload')
/** The workspace syncs with another account than the signed-in one: sends it to the signed-in account (everything goes up, nothing is deleted). */
export const syncAcceptAccount = () => invoke<void>('sync_accept_account')
/** `user@https://server` as shown to people: without the scheme. */
export const accountShown = (label: string) => label.replace('@https://', '@')
/** The account the signed-in person is, as `user@server`. */
export const signedInShown = (s: { username: string | null; server: string }) => accountShown(`${s.username ?? ''}@${s.server}`)
/** The workspace's id is used by another account on the server: gives it a new identity and uploads it as a separate workspace (only while the reason is VAULT_TAKEN). */
/** Gives the open workspace a new id (the old one belongs to another account); resolves with the new id. The app must reload after it. */
export const syncNewIdentity = () => invoke<string>('sync_new_identity')
export const syncNow = () => invoke<void>('sync_now')
export const syncHeld = () => invoke<HeldDelete[]>('sync_held')
/** Confirms exactly the list the person was shown. */
export const syncConfirm = (items: HeldDelete[]) =>
  // an empty list means the held list was not loaded (an older state): confirm what is planned, as before, instead of nothing
  invoke<void>('sync_confirm', { items: items.length > 0 ? items : null })
export const cloudTrashed = () => invoke<TrashedVault[]>('cloud_trashed')
export const cloudRestore = (id: string) => invoke<void>('cloud_restore', { id })
/** Moves a workspace to the server's trash. True when that was the open one and its sync on this device was turned off. */
export const cloudDelete = (id: string) => invoke<boolean>('cloud_delete', { id })
/** Removes a workspace in the server's trash for good (the signed-in device is enough). True when that was the open one and its sync on this device was turned off. */
export const cloudPurge = (id: string) => invoke<boolean>('cloud_purge', { id })
export const accountDelete = (password: string) => invoke<number>('account_delete', { password })
export const cloudVaults = () => invoke<ServerVault[]>('cloud_vaults')
export const cloudDownload = (id: string, name: string, parent: string) => invoke<void>('cloud_download', { id, name, parent })

export const formatBytes = (n = 0) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0) + ' MB')

/** A message for the person from an error of the sync backend. Unknown codes are shown as they are, without the technical lines. */
export function syncError(e: unknown): string {
  const raw = String(e)
  const code = raw.split('\n')[0].replace(/^Error:\s*/, '')
  const known = codeMessage(code, t)
  if (known) return known
  return explain(code)
}

/** Like `syncError`, for a dialog that asks for the account password again: there a rejected password is just a wrong password. */
export function passwordError(e: unknown): string {
  const code = String(e).split('\n')[0].replace(/^Error:\s*/, '')
  return code === 'HUB:bad_credentials' ? t('The password is wrong.') : syncError(e)
}

/** Like `syncError`, for a purge: a server that still asks for the password answers with a rejected one. */
export function purgeError(e: unknown): string {
  const code = String(e).split('\n')[0].replace(/^Error:\s*/, '')
  return code === 'HUB:bad_credentials' ? t('This server still asks for the password. Update the server.') : syncError(e)
}
