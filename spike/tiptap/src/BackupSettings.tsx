import { useEffect, useState } from 'react'
import { backupNow, backupStatus, backupSupported, chooseBackupFolder, disableBackup, grantAccess } from './autobackup'
import { t, locale } from './i18n'
import * as Ic from './icons'

const when = (ts?: number) => (ts ? new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('Not yet'))

export function BackupSettings({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState(backupStatus())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const h = () => setSt(backupStatus())
    window.addEventListener('backup-status', h)
    return () => window.removeEventListener('backup-status', h)
  }, [])
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await f()
    } finally {
      setBusy(false)
      setSt(backupStatus())
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal backup-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{t('Automatic backup')}</b>
            <small>{t('A full copy of all pages and images in a folder you choose.')}</small>
          </div>
          <button className="icon-btn" title={t('Close')} onClick={onClose}><Ic.Close size={16} /></button>
        </div>
        <div className="backup-body">
          {!backupSupported() ? (
            <p className="backup-warn">{t('This browser does not support folder selection. Use Edge or Chrome; until then, manual “Full backup” still works.')}</p>
          ) : (
            <>
              <dl className="backup-info">
                <dt>{t('Status')}</dt>
                <dd>{st.enabled ? (st.error === 'NEEDS_PERMISSION' ? t('Needs access permission') : st.error ? t('Error') : t('On')) : t('Off')}</dd>
                <dt>{t('Folder')}</dt>
                <dd dir="auto">{st.folder ?? '—'}</dd>
                <dt>{t('Last backup')}</dt>
                <dd>{when(st.lastAt)}</dd>
              </dl>
              {st.error && st.error !== 'NEEDS_PERMISSION' && <p className="backup-warn" dir="auto">{st.error}</p>}
              {st.error === 'NEEDS_PERMISSION' && <p className="backup-warn">{t('After closing the browser, folder access must be granted again.')}</p>}
              <ul className="backup-notes">
                <li>{t('The file')} <code>notes-backup-latest.json</code> {t('is updated after changes (at most every 2 minutes) and when the tab is closed or hidden.')}</li>
                <li>{t('A daily file')} <code>notes-backup-{t('date')}.json</code> {t('is also created; the last 14 days are kept.')}</li>
                <li>{t('To restore: “Data & backup → Restore from backup” and pick one of these files.')}</li>
              </ul>
              <div className="backup-acts">
                {!st.enabled || !st.folder ? (
                  <button className="primary" disabled={busy} onClick={() => run(chooseBackupFolder)}>{t('Choose folder and turn on')}</button>
                ) : (
                  <>
                    {st.error === 'NEEDS_PERMISSION' && <button className="primary" disabled={busy} onClick={() => run(grantAccess)}>{t('Grant access')}</button>}
                    <button disabled={busy} onClick={() => run(backupNow)}>{t('Back up now')}</button>
                    <button disabled={busy} onClick={() => run(chooseBackupFolder)}>{t('Change folder')}</button>
                    <button className="danger" disabled={busy} onClick={() => run(disableBackup)}>{t('Turn off')}</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
