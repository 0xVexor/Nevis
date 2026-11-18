// A small sync indicator for the sidebar: what the sync is doing, anything that needs the person, and pages with unresolved conflicts.
// Settings → Sync stays the place to act; this only makes the state visible outside it. Desktop only, and only when sync is part of the release.
import { useEffect, useState } from 'react'
import { Popover } from '../design-system'
import { isTauri, onPageConflictsChanged, pageConflictsList } from '../db'
import { OPEN_PAGE } from '../editor/pageLink'
import { t } from '../i18n'
import { SYNC_ENABLED } from '../releaseFeatures'
import { ago } from '../ui'
import type { ConflictMarker } from '../conflict/types'
import { accountStatus, type SyncStatus } from './client'

const POLL_MS = 20_000

type Tone = 'quiet' | 'busy' | 'attention' | 'error'

/** What to show for a status; null when the indicator stays hidden. */
export function describeSync(s: SyncStatus | null): { text: string; tone: Tone } | null {
  if (!s) return null
  if (!s.syncOn) {
    // sync is off here, but an account that needs signing in again should not go unnoticed
    return s.signedIn && s.state === 'paused' && s.reason === 'SIGNED_OUT' ? { text: t('Signed out — sign in to sync'), tone: 'attention' } : null
  }
  switch (s.state) {
    case 'idle':
      return { text: s.lastAt ? t('Synced · {time}', { time: ago(s.lastAt) }) : t('Synced'), tone: 'quiet' }
    case 'syncing':
    case 'pending':
      return { text: t('Syncing…'), tone: 'busy' }
    case 'offline':
      return { text: t('Offline — will retry'), tone: 'quiet' }
    case 'error':
      return { text: s.error || t('Sync failed'), tone: 'error' }
    case 'paused':
      switch (s.reason) {
        case 'SIGNED_OUT': return { text: t('Signed out — sign in to sync'), tone: 'attention' }
        case 'NEEDS_CONFIRM': return { text: t('{n} deletions are waiting for your OK', { n: s.error }), tone: 'attention' }
        case 'VAULT_MISSING': return { text: t('The vault folder was not found.'), tone: 'attention' }
        case 'VAULT_MISMATCH': return { text: t('A different vault is in this folder.'), tone: 'attention' }
        case 'CLOUD_GONE': return { text: t('This workspace was deleted on the server'), tone: 'attention' }
        default: return { text: t('Sync is paused'), tone: 'attention' }
      }
    default:
      return null
  }
}

export interface SyncIndicatorViewProps {
  status: SyncStatus | null
  conflicts: { id: string; title: string }[]
  onOpenSettings: () => void
  onOpenPage: (pageId: string) => void
}

export function SyncIndicatorView({ status, conflicts, onOpenSettings, onOpenPage }: SyncIndicatorViewProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [, tick] = useState(0)
  // "2 min ago" ages while nothing else changes
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const info = describeSync(status)
  if (!info && !conflicts.length) return null
  const label = conflicts.length === 1 ? t('1 page has a conflict') : t('{n} pages have conflicts', { n: conflicts.length })
  return (
    <div className="sync-ind">
      {info && (
        <button type="button" className="row plain sync-ind-main" data-tone={info.tone} title={info.text} onClick={onOpenSettings}>
          <span className="ic">
            <span className="sync-ind-dot" aria-hidden="true" />
          </span>
          <span className="ntitle" role="status" aria-live="polite">{info.text}</span>
        </button>
      )}
      {conflicts.length > 0 && (
        <button type="button" className="row plain sync-ind-main sync-ind-conflicts" data-tone="attention" aria-haspopup="true" aria-expanded={!!anchor} title={label}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
          <span className="ic">
            <span className="sync-ind-count" aria-hidden="true">{conflicts.length}</span>
          </span>
          <span className="ntitle">{label}</span>
        </button>
      )}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="sync-ind-list" role="group" aria-label={label}>
            {conflicts.map((c) => (
              <button type="button" key={c.id} className="ds-menu-item" onClick={() => (setAnchor(null), onOpenPage(c.id))}>
                <bdi>{c.title || t('Untitled')}</bdi>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}

/** Wires the view to the backend. Renders nothing in the browser build or when sync is not part of the release. */
export function SyncIndicator({ titleOf, onOpenSettings }: { titleOf: (pageId: string) => string | undefined; onOpenSettings: () => void }) {
  const active = isTauri && SYNC_ENABLED
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [markers, setMarkers] = useState<ConflictMarker[]>([])
  useEffect(() => {
    if (!active) return
    let closed = false
    let stop: (() => void) | undefined
    const refresh = () => accountStatus().then((s) => !closed && setStatus(s), () => {})
    const refreshConflicts = () => pageConflictsList().then((m) => !closed && setMarkers(m), () => {})
    void refresh()
    void refreshConflicts()
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('sync-status', refresh))
      .then((off) => (closed ? off() : (stop = off)))
      .catch(() => {})
    const poll = window.setInterval(() => (void refresh(), void refreshConflicts()), POLL_MS)
    const offConflicts = onPageConflictsChanged(() => void refreshConflicts())
    return () => {
      closed = true
      stop?.()
      window.clearInterval(poll)
      offConflicts()
    }
  }, [active])
  if (!active) return null
  // one entry per page (a page may carry several markers); the page's own title wins over the marker's snapshot
  const seen = new Set<string>()
  const conflicts = markers.filter((m) => !seen.has(m.pageId) && !!seen.add(m.pageId)).map((m) => ({ id: m.pageId, title: titleOf(m.pageId) ?? m.local.page.title }))
  return <SyncIndicatorView status={status} conflicts={conflicts} onOpenSettings={onOpenSettings} onOpenPage={(id) => window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: id }))} />
}
