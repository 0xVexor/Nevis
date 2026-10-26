import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { isTauri } from './db'
import { updateSettings, useSettings } from './settings'
import { locale, t } from './i18n'
import * as Ic from './icons'
import { updates, useUpdates } from './updates'
import { updateBusy, type UpdateState } from './updateController'
import appPackage from '../package.json'

const HOURS = 6 * 60 * 60 * 1000
const bytes = (n: number) => `${(n / 1024 / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`

function updateError(error: string) {
  if (error.includes('UPDATES_NOT_CONFIGURED')) return t('Updates are not configured in this build.')
  if (error.includes('UPDATE_SAVE_FAILED')) return t('Your changes could not be saved. Finish any open drawing, then try again.')
  if (error.includes('UPDATE_NOT_READY')) return t('This release is still being prepared. Please try again later.')
  if (/signature|public key|minisign/i.test(error)) return t('The update could not be verified. It was not installed.')
  return t('The update could not be completed. Check your connection and try again.')
}

export function UpdateSettings() {
  const s = useSettings()
  const st = useUpdates()
  if (!isTauri) return <p className="update-status">{t('In-app updates are available in the desktop app.')}</p>
  const status = st.phase === 'checking' ? t('Checking for updates…')
    : st.phase === 'current' ? t('You are up to date.') : st.phase === 'error' ? updateError(st.error)
    : st.update ? t('Version {version} is available', { version: st.update.version })
    : t('New versions are checked automatically. Installation always asks for your approval.')
  return <div className="update-settings">
    <div className="sx-row">
      <div className="sx-tx"><b>{t('Current version')}</b><small><bdi>{appPackage.version}</bdi></small></div>
      <div className="sx-ctl"><button className="update-secondary" disabled={updateBusy(st.phase)} onClick={() => st.update ? updates.open() : void updates.check(true)}>
        {st.update ? t('View update') : st.phase === 'checking' ? t('Checking…') : t('Check for updates')}
      </button></div>
    </div>
    <div className="sx-row">
      <div className="sx-tx"><b>{t('Receive pre-release updates')}</b><small>{t('Include early versions that may be less stable. Off by default.')}</small></div>
      <div className="sx-ctl"><button role="switch" aria-checked={s.prereleaseUpdates} aria-label={t('Receive pre-release updates')} className={'switch' + (s.prereleaseUpdates ? ' on' : '')} disabled={updateBusy(st.phase) && st.phase !== 'checking'} onClick={() => updateSettings({ prereleaseUpdates: !s.prereleaseUpdates })} /></div>
    </div>
    <p className="update-status" role="status">{status}</p>
  </div>
}

export function UpdateNotice({ state: st }: { state: UpdateState }) {
  if (!st.update || !st.notice) return null
  return <aside className="update-notice" role="status" aria-label={t('Update available')}>
    <span className="update-icon"><Ic.Download size={20} /></span>
    <div className="update-notice-text"><b>{t('Update available')}</b><span>{t('Version {version} is available', { version: st.update.version })}</span>
      <button className="update-link" onClick={() => updates.open()}>{t('View update')}<Ic.Chevron size={13} /></button>
    </div>
    <button className="icon-btn" title={t('Later')} aria-label={t('Later')} onClick={() => updates.dismiss()}><Ic.Close size={15} /></button>
  </aside>
}

export function UpdateDialog({ state: st }: { state: UpdateState }) {
  const ref = useRef<HTMLDivElement>(null)
  const u = st.update
  const busy = updateBusy(st.phase)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  if (!u) return null
  const downloading = st.phase === 'downloading'
  const installing = st.phase === 'saving' || st.phase === 'installing'
  const ready = st.phase === 'ready'
  const progress = st.progress.total && st.progress.total > 0 ? Math.min(100, Math.round(st.progress.downloaded / st.progress.total * 100)) : null
  return <div className="overlay picker update-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && updates.close()} onKeyDown={(e) => {
    e.stopPropagation()
    if (e.key === 'Escape' && !busy) updates.close()
    if (e.key === 'Tab') {
      const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]')
      if (!items?.length) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus() }
    }
  }}>
    <div ref={ref} className="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-description" tabIndex={-1}>
      <div className="modal-head"><b>{t('App update')}</b><button className="icon-btn" title={t('Close')} aria-label={t('Close')} disabled={busy} onClick={() => updates.close()}><Ic.Close /></button></div>
      <div className="update-body">
        <div className="acct-hero">
          <span className="acct-hero-ic"><Ic.Download size={24} /></span>
          <h3 id="update-title">{ready ? t('Ready to install') : t('A new version of Nevis is here')}</h3>
          <p id="update-description">{ready ? t('Your changes will be saved before Nevis restarts.') : t('Download the update, then restart when you are ready.')}</p>
        </div>
        <div className="update-versions"><bdi>{appPackage.version}</bdi><span aria-hidden="true">→</span><bdi>{u.version}</bdi><span className={'update-channel' + (u.prerelease ? ' preview' : '')}>{u.prerelease ? t('Pre-release') : t('Stable')}</span></div>
        {u.prerelease && <p className="acct-note">{t('This is a pre-release version. Some features may be unfinished.')}</p>}
        {u.notes && <section className="update-notes" aria-label={t('What’s new')}><b>{t('What’s new')}</b><p dir="auto">{u.notes}</p></section>}
        {(downloading || installing || ready) && <div className="update-download" role="status" aria-live="polite">
          <div className="update-download-label"><span>{st.phase === 'saving' ? t('Saving your changes…') : st.phase === 'installing' ? t('Installing and restarting…') : ready ? t('Download complete') : t('Downloading update…')}</span><bdi>{ready ? <Ic.Check size={16} /> : downloading ? progress === null ? bytes(st.progress.downloaded) : `${progress}%` : null}</bdi></div>
          <progress aria-label={t('Download progress')} max={100} value={ready || installing ? 100 : progress ?? undefined} />
          {downloading && <small><bdi>{bytes(st.progress.downloaded)}{st.progress.total ? ` / ${bytes(st.progress.total)}` : ''}</bdi></small>}
        </div>}
        {st.error && <p className="acct-err" role="alert">{updateError(st.error)}</p>}
      </div>
      <div className="update-actions">
        <button className="update-secondary" disabled={busy} onClick={() => updates.dismiss()}>{t('Later')}</button>
        <button className="primary" disabled={busy} onClick={() => void (ready ? updates.install() : updates.download())}>
          {installing ? t('Installing…') : downloading ? t('Downloading…') : ready ? t('Install and restart') : st.phase === 'error' ? t('Try again') : t('Download update')}
        </button>
      </div>
    </div>
  </div>
}

/** Always mounted, so checking and progress survive switching between pages/settings. */
export function UpdateCenter() {
  const s = useSettings()
  const st = useUpdates()
  const channel = useRef(s.prereleaseUpdates)
  useEffect(() => {
    if (!isTauri) return
    const changed = channel.current !== s.prereleaseUpdates
    channel.current = s.prereleaseUpdates
    if (changed) updates.channelChanged()
    let last = Date.now()
    const timer = window.setTimeout(() => void updates.check(), 10_000)
    const check = () => {
      if (document.hidden || Date.now() - last < HOURS) return
      last = Date.now()
      void updates.check()
    }
    const interval = window.setInterval(check, HOURS)
    document.addEventListener('visibilitychange', check)
    const online = () => { if (!document.hidden) { last = Date.now(); void updates.check() } }
    window.addEventListener('online', online)
    return () => { window.clearTimeout(timer); window.clearInterval(interval); document.removeEventListener('visibilitychange', check); window.removeEventListener('online', online) }
  }, [s.prereleaseUpdates])
  if (!isTauri) return null
  return createPortal(<><UpdateNotice state={st} />{st.dialog && <UpdateDialog state={st} />}</>, document.body)
}
