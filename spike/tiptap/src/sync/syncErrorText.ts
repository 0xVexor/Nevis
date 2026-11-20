// Text for what the sync backend reports. Pure (the translator is passed in) so it can be tested without the app.
// Never shows the backend's raw lines: those carry endpoints, paths and status numbers that mean nothing to a person.

export type Translate = (key: string, vars?: Record<string, string>) => string

/** The part of the sync status these functions read. */
export interface ErrorStatus {
  state?: string
  reason?: string
  error?: string
  errorCode?: string
  errorPath?: string
}

const CODE = /(?:HUB|AUTH|NETWORK|STORAGE):[A-Za-z0-9_]+/
const isolate = (s: string) => `⁦${s}⁩`

/** The notices that stay until the person acts; the backend keeps their `reason` while a round runs. */
export const STICKY_REASONS = ['SIGNED_OUT', 'CLOUD_GONE', 'ACCOUNT_CHANGED', 'VAULT_TAKEN']
export const isSticky = (s: { reason?: string }) => STICKY_REASONS.includes(s.reason ?? '')

/** The account's login is no longer accepted (password changed, device revoked, recovered elsewhere): the sign-in form is what is needed. */
export function needsSignIn(s: { signedIn: boolean; reason?: string; state?: string; errorCode?: string }): boolean {
  if (!s.signedIn) return true
  return s.reason === 'SIGNED_OUT' || (s.state === 'error' && (s.errorCode === 'AUTH:unauthorized' || s.errorCode === 'AUTH:signed_out'))
}

/** The last two parts of a path, at most 48 characters, with an ellipsis where it was cut. Empty for anything that looks like a URL. */
export function shortenPath(path: string): string {
  const p = path.replace(/\\/g, '/').trim()
  if (!p || /[a-z][a-z0-9+.-]*:\/\//i.test(p)) return ''
  const parts = p.split('/').filter(Boolean)
  let out = parts.slice(-2).join('/')
  if (parts.length > 2) out = '…/' + out
  if (out.length > 48) out = '…' + out.slice(-47)
  return out
}

/** Text for a known code of the backend, or null. */
export function codeMessage(code: string, tr: Translate): string | null {
  const known: Record<string, string> = {
    'AUTH:unauthorized': 'You are signed out of the server. Sign in again.',
    'AUTH:signed_out': 'You are signed out of the server. Sign in again.',
    'HUB:bad_credentials': 'The user name or password is wrong.',
    'HUB:username_taken': 'This user name is taken.',
    'HUB:bad_username': 'Use 3 to 32 letters, digits, dots, dashes or underscores for the user name.',
    'HUB:weak_password': 'The password is too short or too weak.',
    'HUB:registration_closed': 'This server does not take new accounts.',
    'HUB:bad_invite': 'The invite code is wrong.',
    'HUB:invite_used': 'This invite code has been used up.',
    'HUB:bad_recovery_key': 'The recovery key is wrong.',
    'HUB:rate_limited': 'The server asked to slow down. It will continue by itself.',
    'HUB:too_many_attempts': 'Too many attempts. Wait a little and try again.',
    'HUB:too_many_uploads': 'Too many unfinished uploads. They clear by themselves; try again in a few minutes.',
    'HUB:quota_exceeded': 'The storage of this account on the server is full.',
    'HUB:not_nevis': 'This address answers, but it is not a Nevis sync server.',
    'HUB:insecure_server': 'Use an https:// address. Plain http:// works only for this computer.',
    'HUB:not_in_trash': 'This workspace is not in the server trash.',
    'HUB:vault_deleted': 'This workspace is in the server trash. Restore it from there, then sync again.',
    'HUB:too_large': 'A file is too large for this server.',
    'HUB:vault_taken': 'This workspace’s ID is already used by another account on this server (for example a copy of a folder that syncs elsewhere).',
    'HUB:no_such_vault': 'This workspace is not on the server (any more).',
    'HUB:bad_server': 'This server address is not valid.',
  }
  if (known[code]) return tr(known[code])
  if (code.startsWith('NETWORK:')) return tr('The server cannot be reached. Check the address and your connection.')
  if (code.startsWith('HUB:http_')) return tr('The server answered with an error ({code}).', { code: code.slice('HUB:http_'.length) })
  return null
}

/** The code of a status: the backend's own field, else the code inside an older backend's raw text. */
export function statusCode(s: ErrorStatus): string {
  if (s.errorCode) return s.errorCode
  return (s.error ?? '').match(CODE)?.[0] ?? ''
}

/** What to tell the person about a failed sync. `path` is the shortened path of the file concerned ('' when none); in `text` it sits in a left-to-right isolate. */
export function describeSyncError(s: ErrorStatus, tr: Translate): { text: string; code: string; path: string } {
  const code = statusCode(s)
  const path = shortenPath(s.errorPath ?? '')
  if (code === 'HUB:too_large') {
    const text = path ? tr('A file is too large for this server: {path}', { path: isolate(path) }) : tr('A file is too large for this server.')
    return { text, code, path }
  }
  const known = codeMessage(code, tr)
  if (known) return { text: known, code, path }
  // an unknown code: a generic message plus the short code, only when it is a plain code (never free text or URLs)
  const short = /^[A-Za-z]+:[A-Za-z0-9_]{1,40}$/.test(code) ? code : ''
  return { text: short ? tr('Sync failed ({code})', { code: short }) : tr('Sync failed'), code: short, path }
}
