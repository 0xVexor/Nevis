import { useEffect, useState } from 'react'
import { accountStatus, syncNow, type AccountStatus } from './db'
import { locale, t } from './i18n'

const when = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(locale(), { timeStyle: 'short' }) : '')

/** Top-bar sync button (desktop app). One click syncs now; the app also syncs by itself every minute. */
export function SyncButton({ onSetup }: { onSetup: () => void }) {
  const [st, setSt] = useState<AccountStatus | null>(null)
  useEffect(() => {
    const poll = () => void accountStatus().then(setSt, () => {})
    poll()
    const id = window.setInterval(poll, 2500)
    return () => window.clearInterval(id)
  }, [])
  if (!st) return null

  const on = !!st.email && st.syncOn
  const busy = on && st.state === 'syncing'
  const failed = on && st.state === 'error'
  const title = !on
    ? t('Sync is off — click to set it up')
    : busy
      ? t('Syncing…')
      : failed
        ? t('Sync failed: {error}. Click to try again.', { error: st.error })
        : st.lastAt
          ? t('Synced at {time}. Click to sync now.', { time: when(st.lastAt) })
          : t('Click to sync now')

  return (
    <button
      className={'icon-btn sync-btn' + (busy ? ' spinning' : '') + (failed ? ' sync-failed' : '') + (on ? '' : ' sync-off')}
      title={title}
      disabled={busy}
      onClick={() => (on ? void syncNow().then(() => accountStatus().then(setSt)) : onSetup())}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9" />
        <path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" />
      </svg>
    </button>
  )
}
