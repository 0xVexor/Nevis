// The calls the settings page makes to the app's sync. Desktop only: the browser version has no sync.
// Errors arrive as the backend's codes (`AUTH:unauthorized`, `HUB:username_taken`, `NETWORK:...`); `syncError` makes text of them.
import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'
import { explain } from '../vaultErrors'

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
  /** why it is paused: SIGNED_OUT | NEEDS_CONFIRM (then `error` is the number of held deletions) | VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE */
  reason: string
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
export const syncSet = (on: boolean) => invoke<void>('sync_set', { on })
export const syncNow = () => invoke<void>('sync_now')
export const syncConfirm = () => invoke<void>('sync_confirm')
export const cloudVaults = () => invoke<ServerVault[]>('cloud_vaults')
export const cloudDownload = (id: string, name: string, parent: string) => invoke<void>('cloud_download', { id, name, parent })

/** A message for the person from an error of the sync backend. Unknown codes are shown as they are, without the technical lines. */
export function syncError(e: unknown): string {
  const raw = String(e)
  const code = raw.split('\n')[0].replace(/^Error:\s*/, '')
  const known: Record<string, string> = {
    'AUTH:unauthorized': t('You are signed out of the server. Sign in again.'),
    'AUTH:signed_out': t('You are signed out of the server. Sign in again.'),
    'HUB:bad_credentials': t('The user name or password is wrong.'),
    'HUB:username_taken': t('This user name is taken.'),
    'HUB:bad_username': t('Use 3 to 32 letters, digits, dots, dashes or underscores for the user name.'),
    'HUB:weak_password': t('The password is too short or too weak.'),
    'HUB:registration_closed': t('This server does not take new accounts.'),
    'HUB:bad_invite': t('The invite code is wrong.'),
    'HUB:invite_used': t('This invite code has been used up.'),
    'HUB:bad_recovery_key': t('The recovery key is wrong.'),
    'HUB:rate_limited': t('Too many attempts. Wait a little and try again.'),
    'HUB:quota_exceeded': t('The storage of this account on the server is full.'),
    'HUB:not_nevis': t('This address answers, but it is not a Nevis sync server.'),
    'HUB:insecure_server': t('Use an https:// address. Plain http:// works only for this computer.'),
    'HUB:bad_server': t('This server address is not valid.'),
  }
  if (known[code]) return known[code]
  if (code.startsWith('NETWORK:')) return t('The server cannot be reached. Check the address and your connection.')
  if (code.startsWith('HUB:http_')) return t('The server answered with an error ({code}).').replace('{code}', code.slice('HUB:http_'.length))
  return explain(code)
}
