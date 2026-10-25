import { t } from './i18n'

/** Turns an error from the desktop backend (it answers with codes such as VAULT_MISSING) into a message for the user. */
export const explain = (e: unknown) => {
  const m = String(e)
  if (m.includes('NOT_CONFIGURED')) return t('Google sign-in is not set up in this build of the app.')
  if (m.includes('VAULT_MISSING')) return t('The vault folder was not found.')
  if (m.includes('VAULT_MISMATCH')) return t('A different vault is in this folder.')
  if (m.includes('CLOUD_GONE')) return t('The cloud copy of this vault does not exist any more.')
  return m
}
