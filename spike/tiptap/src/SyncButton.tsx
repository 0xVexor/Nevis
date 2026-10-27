import { useEffect, useState } from 'react'
import { accountStatus, syncNow, type AccountStatus } from './db'
import { locale, t } from './i18n'
import { explain } from './vaultErrors'

const when = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(locale(), { timeStyle: 'short' }) : '')

/**
 * Top-bar sync button (desktop app). One click syncs now; the app also syncs by itself, within a second of a change
 * on any device. Signed out, it opens the account dialog; signed in with sync off, the workspaces dialog where it is turned on.
 */
export function SyncButton({ onSetup, onSignIn }: { onSetup: () => void; onSignIn: () => void }) {
  const [st, setSt] = useState<AccountStatus | null>(null)
  useEffect(() => {
    const poll = () => void accountStatus().then(setSt, () => {})
    poll()
    const id = window.setInterval(poll, 2000)
    return () => window.clearInterval(id)
  }, [])
  if (!st) return null

  const on = st.signedIn && st.syncOn
  const busy = on && st.state === 'syncing'
  const offline = on && st.state === 'offline'
  const failed = on && (st.state === 'error' || (st.state === 'paused' && st.reason === 'SIGNED_OUT'))
  const title = !st.signedIn
    ? t('Sync is off — click to sign in')
    : !st.syncOn
      ? t('Sync is off for this workspace — click to set it up')
      : busy
        ? t('Syncing…')
        : offline
          ? t('Offline — your changes are saved here and will sync when the connection is back. Click to try now.')
          : failed
            ? t('Sync failed: {error}. Click to try again.', { error: explain(st.error || st.reason) })
            : st.lastAt
              ? t('Synced at {time}. Click to sync now.', { time: when(st.lastAt) })
              : t('Click to sync now')

  const click = () => {
    if (st.provider === 'github' && (st.state === 'paused' || st.state === 'error' || !st.syncOn)) return onSignIn()
    if (!st.signedIn) return onSignIn()
    if (!st.syncOn) return onSetup()
    void syncNow().then(() => accountStatus().then(setSt))
  }

  return (
    <button
      className={'icon-btn sync-btn' + (busy ? ' spinning' : '') + (failed ? ' sync-failed' : '') + (offline ? ' sync-offline' : '') + (on ? '' : ' sync-off')}
      title={title}
      aria-label={title}
      disabled={busy}
      onClick={click}
    >
      {offline ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 2.4 8.3" />
          <path d="M3 3l18 18" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9" />
          <path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" />
        </svg>
      )}
    </button>
  )
}
