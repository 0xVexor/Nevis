import { Switch } from './design-system/controls'
import { Button, Dialog, Icon, Notice, PreferenceRow } from './design-system'
import { IconButton } from './design-system/Button'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { isTauri } from './db'
import { updateSettings, useSettings } from './settings'
import { locale, t } from './i18n'
import { updates, useUpdates } from './updates'
import { isPrereleaseBuild, updateBusy, wantsPrerelease, type UpdateState } from './updateController'
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
  if (!isTauri) return <p className="prefs-note">{t('In-app updates are available in the desktop app.')}</p>
  const status =
    st.phase === 'checking'
      ? t('Checking for updates…')
      : st.phase === 'current'
        ? t('You are up to date.')
        : st.phase === 'error'
          ? updateError(st.error)
          : st.update
            ? t('Version {version} is available', { version: st.update.version })
            : t('New versions are checked automatically. Installation always asks for your approval.')
  return (
    <>
      <PreferenceRow label={t('Current version')} hint={<bdi>{appPackage.version}</bdi>}>
        <Button disabled={updateBusy(st.phase)} onClick={() => (st.update ? updates.open() : void updates.check(true))}>
          {st.update ? t('View update') : st.phase === 'checking' ? t('Checking…') : t('Check for updates')}
        </Button>
      </PreferenceRow>
      <PreferenceRow
        label={t('Receive pre-release updates')}
        hint={isPrereleaseBuild(appPackage.version) ? t('This is a pre-release build, so it always receives newer pre-releases.') : t('Include early versions that may be less stable. Off by default.')}
      >
        <Switch checked={wantsPrerelease(s.prereleaseUpdates, appPackage.version)} label={t('Receive pre-release updates')} disabled={isPrereleaseBuild(appPackage.version) || (updateBusy(st.phase) && st.phase !== 'checking')} onChange={prereleaseUpdates => updateSettings({ prereleaseUpdates })} />
      </PreferenceRow>
      <p className="prefs-note" role="status">
        {status}
      </p>
    </>
  )
}

export function UpdateNotice({ state: st }: { state: UpdateState }) {
  if (!st.update || !st.notice) return null
  return (
    <Notice
      className="update-notice"
      role="status"
      title={t('Update available')}
      icon={<Icon name="download" size={16} />}
      action={
        <Button size="sm" onClick={() => updates.open()}>
          {t('View update')}
          <Icon name="chevron-right" size={14} className="ds-flip" />
        </Button>
      }
      trailing={
        <IconButton label={t('Later')} onClick={() => updates.dismiss()}>
          <Icon name="x" size={15} />
        </IconButton>
      }
    >
      {t('Version {version} is available', { version: st.update.version })}
    </Notice>
  )
}

export function UpdateDialog({ state: st }: { state: UpdateState }) {
  const u = st.update
  const busy = updateBusy(st.phase)
  if (!u) return null
  const downloading = st.phase === 'downloading'
  const installing = st.phase === 'saving' || st.phase === 'installing'
  const ready = st.phase === 'ready'
  const progress = st.progress.total && st.progress.total > 0 ? Math.min(100, Math.round((st.progress.downloaded / st.progress.total) * 100)) : null
  return (
    <Dialog
      open
      title={t('App update')}
      onClose={() => !busy && updates.close()}
      actions={
        <>
          <Button disabled={busy} onClick={() => updates.dismiss()}>
            {t('Later')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void (ready ? updates.install() : updates.download())}>
            {installing ? t('Installing…') : downloading ? t('Downloading…') : ready ? t('Install and restart') : st.phase === 'error' ? t('Try again') : t('Download update')}
          </Button>
        </>
      }
    >
      <div className="ds-modal-body update-body">
        <div className="update-lead">
          <b>{ready ? t('Ready to install') : t('A new version of Nevis is here')}</b>
          <p>{ready ? t('Your changes will be saved before Nevis restarts.') : t('Download the update, then restart when you are ready.')}</p>
        </div>
        <div className="update-versions">
          <bdi>{appPackage.version}</bdi>
          <Icon name="arrow-right" size={14} className="ds-flip" />
          <bdi>{u.version}</bdi>
          <span className={'update-channel' + (u.prerelease ? ' preview' : '')}>{u.prerelease ? t('Pre-release') : t('Stable')}</span>
        </div>
        {u.prerelease && <Notice tone="warn">{t('This is a pre-release version. Some features may be unfinished.')}</Notice>}
        {u.notes && (
          <section className="update-notes" aria-label={t('What’s new')}>
            <b>{t('What’s new')}</b>
            <p dir="auto">{u.notes}</p>
          </section>
        )}
        {(downloading || installing || ready) && (
          <div className="update-download" role="status" aria-live="polite">
            <div className="update-download-label">
              <span>{st.phase === 'saving' ? t('Saving your changes…') : st.phase === 'installing' ? t('Installing and restarting…') : ready ? t('Download complete') : t('Downloading update…')}</span>
              <bdi>{ready ? <Icon name="check" size={16} /> : downloading ? (progress === null ? bytes(st.progress.downloaded) : `${progress}%`) : null}</bdi>
            </div>
            <progress aria-label={t('Download progress')} max={100} value={ready || installing ? 100 : (progress ?? undefined)} />
            {downloading && (
              <small>
                <bdi>
                  {bytes(st.progress.downloaded)}
                  {st.progress.total ? ` / ${bytes(st.progress.total)}` : ''}
                </bdi>
              </small>
            )}
          </div>
        )}
        {st.error && <Notice tone="bad">{updateError(st.error)}</Notice>}
      </div>
    </Dialog>
  )
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
    const online = () => {
      if (!document.hidden) {
        last = Date.now()
        void updates.check()
      }
    }
    window.addEventListener('online', online)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('online', online)
    }
  }, [s.prereleaseUpdates])
  if (!isTauri) return null
  return createPortal(
    <>
      <UpdateNotice state={st} />
      {st.dialog && <UpdateDialog state={st} />}
    </>,
    document.body,
  )
}
