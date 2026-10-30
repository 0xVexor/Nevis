import { t } from './i18n'

/** Turns an error from the desktop backend into a message for the user. The backend answers with codes such as VAULT_MISSING. */
export const explain = (e: unknown) => {
  const m = String(e)
  if (m.includes('VAULT_IN_USE')) return t('This workspace is already open in another Nevis process. Close it there before opening it here.')
  if (m.includes('VAULT_LOCK_LOST') || m.includes('VAULT_LOCK_UNAVAILABLE')) return t('The workspace lock is unavailable. Local writes stopped to protect the files. Reopen the workspace after checking its folder.')
  if (m.includes('VAULT_UNSUPPORTED_FORMAT')) return t('This workspace needs a newer compatible Nevis version. Its files were kept.')
  if (m.includes('VAULT_MISSING')) return t('The vault folder was not found.')
  if (m.includes('VAULT_MISMATCH')) return t('A different vault is in this folder.')
  return m
}
