import { useEffect, useRef, useState } from 'react'
import { accountStatus, type AccountStatus } from './db'
import { locale, t } from './i18n'
import { syncWorkspaceNow } from './syncActions'
import { explain } from './vaultErrors'

const when = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(locale(), { timeStyle: 'short' }) : '')

/**
 * Top-bar sync button (desktop app). One click saves pending editor/preferences work and requests a sync. Background sync follows the provider policy. Signed out, it opens the account dialog; signed in with sync off, the workspaces dialog where it is turned on.
 */
export function SyncButton({ onSetup, onSignIn, onConflicts }: { onSetup: () => void; onSignIn: () => void; onConflicts: () => void }) {
  const [st, setSt] = useState<AccountStatus | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const notified = useRef(false)
  useEffect(() => {
    const poll = () => void accountStatus().then(setSt, () => {})
    poll()
    const id = window.setInterval(poll, 2000)
    return () => window.clearInterval(id)
  }, [])
  const conflicts = st?.provider === 'github' && st.reason === 'CONFLICTS'
  useEffect(() => {
    if (conflicts && !notified.current) { notified.current = true; onConflicts() }
    if (!conflicts) notified.current = false
  }, [conflicts, onConflicts])
  if (!st) return null

  const on = st.signedIn && st.syncOn
  const busy = saving || (on && st.state === 'syncing')
  const offline = on && st.state === 'offline'
  const failed = on && (st.state === 'error' || (st.state === 'paused' && st.reason === 'SIGNED_OUT'))
  const title = error || (conflicts ? t('Review sync conflicts') : !st.signedIn
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
              : t('Click to sync now'))

  const click = () => {
    if (conflicts) return onConflicts()
    if (st.provider === 'github' && (st.state === 'paused' || st.state === 'error' || !st.syncOn)) return onSignIn()
    if (!st.signedIn) return onSignIn()
    if (!st.syncOn) return onSetup()
    setSaving(true); setError('')
    void syncWorkspaceNow().then(() => accountStatus().then(setSt)).catch(e => setError(String(e))).finally(() => setSaving(false))
  }

  return (
    <button
      className={'icon-btn sync-btn' + (busy ? ' spinning' : '') + (failed || error ? ' sync-failed' : '') + (conflicts ? ' sync-conflict' : '') + (offline ? ' sync-offline' : '') + (on ? '' : ' sync-off')}
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
