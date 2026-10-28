import { t } from './i18n'

/** What the server says (`HUB:<code>`), in words for the user. The keys are the English source strings of `t()`. */
const SERVER_SAYS: Record<string, string> = {
  permanent_delete_unavailable: 'This server could not process permanent deletion. The workspace remains in the server trash and can still be restored. The server may need an update.',
  server_upgrade_required: 'This server does not support database sync yet. Update the server before syncing this workspace. No files were changed by this sync.',
  unsafe_path: 'Sync stopped because a file path is not supported. Check the error details. No files were changed by this sync.',
  bad_path: 'The server rejected a file path. Your local file is kept. Check the error details.',
  path_case_clash: 'Two file paths differ only in letter case. Rename one before syncing. Check the error details.',
  not_found: 'The server did not recognize this operation. It may need an update. Check the error details.',
  bad_credentials: 'The user name or the password is not right.',
  bad_recovery_key: 'The recovery key is not right.',
  username_taken: 'This user name is taken. Choose another one.',
  bad_username: 'A user name has 3 to 32 letters, digits, dots, dashes or underscores, and starts with a letter or digit.',
  weak_password: 'The password needs at least 8 characters.',
  bad_invite: 'This invite code is not valid.',
  invite_used: 'This invite code has been used up.',
  registration_closed: 'This server is not taking new accounts.',
  bad_pow: 'The sign-up check failed. Try again.',
  bad_challenge: 'The sign-up check failed. Try again.',
  challenge_expired: 'The sign-up check took too long. Try again.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  upgrade_required: 'This version of Nevis is too old for the server. Update the app.',
  insecure_server: 'The server address must start with https://.',
  bad_server: 'This is not a valid server address.',
  quota_exceeded: 'Your storage on the server is full.',
  too_large: 'A file is larger than the server accepts.',
  too_many_vaults: 'You have reached the number of vaults an account may have.',
  vault_taken: 'A vault with this id already belongs to another account.',
  vault_deleted: 'The cloud copy of this vault is in the server trash. Restore it from your account first.',
  no_such_vault: 'The cloud copy of this vault does not exist.',
  inconsistent: 'The copy on the server could not be verified. Nothing was changed; try again in a moment.',
  conflict: 'Another device changed this at the same moment. It will be merged on the next sync.',
  internal: 'The server had a problem. Try again in a moment.',
  not_in_trash: 'Only a vault that is in the server trash can be deleted for good.',
  not_noviq: 'This address does not answer like a Nevis sync server. Check the address, or the server may not be running yet.',
  http_401: 'This address does not answer like a Nevis sync server. Check the address, or the server may not be running yet.',
  http_404: 'This address does not answer like a Nevis sync server. Check the address, or the server may not be running yet.',
}

/**
 * Turns an error from the desktop backend into a message for the user. The backend answers with codes: VAULT_MISSING,
 * NETWORK:… (the server cannot be reached), AUTH:… (this device is signed out), HUB:<what the server said>.
 */
export const explain = (e: unknown) => {
  const m = String(e)
  if (m.includes('NETWORK:')) return t('The server cannot be reached. Your changes are saved on this device and are sent when the connection is back.')
  if (m.includes('AUTH:')) return t('You are signed out of this device. Sign in again to keep syncing.')
  if (m.includes('VAULT_IN_USE')) return t('This workspace is already open in another Nevis process. Close it there before opening it here.')
  if (m.includes('VAULT_LOCK_LOST') || m.includes('VAULT_LOCK_UNAVAILABLE')) return t('The workspace lock is unavailable. Local writes stopped to protect the files. Reopen the workspace after checking its folder.')
  if (m.includes('VAULT_UNSUPPORTED_FORMAT')) return t('This workspace needs a newer compatible Nevis version. Its files were kept.')
  if (m.includes('VAULT_MISSING')) return t('The vault folder was not found.')
  if (m.includes('VAULT_MISMATCH')) return t('A different vault is in this folder.')
  if (m.includes('CLOUD_GONE')) return t('The cloud copy of this vault does not exist any more.')
  const code = /HUB:(\w+)/.exec(m)?.[1]
  if (code) return SERVER_SAYS[code] ? t(SERVER_SAYS[code]) : t('The server answered: {code}', { code })
  return m
}

/** True for the failures that only mean "no connection": nothing is wrong, it will go through later. */
export const isOffline = (e: unknown) => String(e).includes('NETWORK:')
