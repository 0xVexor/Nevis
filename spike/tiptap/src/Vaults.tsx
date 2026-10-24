import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { accountLogin, accountLogout, accountStatus, freezeStorage, isTauri, syncNow, syncSet, vaultCreate, vaultInfo, vaultList, vaultOpen, type AccountStatus, type VaultEntry } from './db'
import { repo } from './store'
import * as Ic from './icons'
import { locale, t } from './i18n'

const when = (ts: number) => (ts ? new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('Not yet'))

/** Workspaces dialog: the workspace you are in, other vaults to switch to or create, and (desktop app) the Google sync that keeps it on all your devices. */
export function Vaults({ onClose, onNew }: { onClose: () => void; onNew: (create: (name: string) => Promise<void>) => void }) {
  const [id, setId] = useState('')
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [acc, setAcc] = useState<AccountStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => (isTauri ? accountStatus().then(setAcc, () => {}) : Promise.resolve()), [])
  useEffect(() => {
    if (!isTauri) return
    void vaultInfo().then((v) => setId(v.id))
    void vaultList().then((l) => setVaults(l.vaults))
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await f()
    } catch (e) {
      setError(String(e) === 'NOT_CONFIGURED' ? t('Google sign-in is not set up in this build of the app.') : String(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }
  const switchTo = (to: string) =>
    run(async () => {
      if (to === id) return
      await repo.flushed() // nothing may stay unsaved in the vault we leave
      freezeStorage() // and nothing may be written into the next one
      await vaultOpen(to)
      window.location.reload()
    })
  const create = async (vaultName: string) => {
    const parent = await open({ directory: true, multiple: false, title: t('Choose where to create the vault') })
    if (typeof parent !== 'string') return
    await repo.flushed()
    freezeStorage()
    await vaultCreate(parent, vaultName)
    window.location.reload()
  }

  const status = !acc?.syncOn ? t('Off') : acc.state === 'syncing' ? t('Syncing…') : acc.state === 'error' ? t('Error') : t('Up to date')

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wsd" role="dialog" aria-modal="true" aria-label={t('Workspaces')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wsd-head">
          <b>{t('Workspaces')}</b>
          <button className="icon-btn" title={t('Close  Esc')} onClick={onClose}><Ic.Close size={16} /></button>
        </div>

        <div className="wsd-body">
          <div className="wsd-list">
            {isTauri ? (
              vaults.map((v) => (
                <button key={v.id} className={'wsd-row' + (v.id === id ? ' cur' : '')} disabled={busy || !v.exists} onClick={() => void switchTo(v.id)}>
                  <span className="wsd-ic"><Ic.Layers size={17} /></span>
                  <span className="wsd-tx">
                    <b dir="auto">{v.name}</b>
                    <small dir="ltr">{v.exists ? v.path : t('Folder not found')}</small>
                  </span>
                  {v.sync && <span className="wsd-cloud" title={t('Synced')}><Ic.Cloud size={14} /></span>}
                  <span className="wsd-state">{v.id === id ? t('Current workspace') : t('Switch')}</span>
                </button>
              ))
            ) : (
              <div className="wsd-row cur">
                <span className="wsd-ic"><Ic.Layers size={17} /></span>
                <span className="wsd-tx"><b>{t('Personal space')}</b></span>
                <span className="wsd-state">{t('Current workspace')}</span>
              </div>
            )}
          </div>

          {!isTauri && <p className="wsd-note">{t('Your notes live locally. This preview uses its own sample content, separate from your Noviq workspace.')}</p>}

          {isTauri && (
            <button className="wsd-new" disabled={busy} onClick={() => (onClose(), onNew(create))}>
              <span className="wsd-ic"><Ic.Plus size={16} /></span>{t('New workspace…')}
            </button>
          )}

          {isTauri && (
            <section className="wsd-sync">
              <h4>{t('Sync between devices')}</h4>
              {error && <p className="backup-warn" dir="auto">{error}</p>}
              {!acc?.email ? (
                <div className="wsd-card">
                  <p>{t('Sign in with your Google account and Noviq keeps this vault in sync on all your devices. Nothing else to set up.')}</p>
                  <button className="primary" disabled={busy || acc?.configured === false} onClick={() => run(accountLogin)}>{busy ? t('Waiting for the browser…') : t('Sign in with Google')}</button>
                  {acc?.configured === false && <p className="backup-warn">{t('Google sign-in is not set up in this build of the app.')}</p>}
                </div>
              ) : (
                <div className="wsd-card">
                  <dl className="wsd-info">
                    <dt>{t('Account')}</dt><dd dir="ltr">{acc.email}</dd>
                    <dt>{t('Sync this vault')}</dt><dd><i className={'wsd-dot ' + (acc.syncOn ? acc.state : 'off')} />{status}</dd>
                    <dt>{t('Last sync')}</dt><dd>{when(acc.lastAt)}</dd>
                  </dl>
                  {acc.state === 'error' && acc.error && <p className="backup-warn" dir="auto">{acc.error}</p>}
                  <div className="wsd-acts">
                    {acc.syncOn ? (
                      <>
                        <button disabled={busy} onClick={() => run(syncNow)}><Ic.Cloud size={15} />{t('Sync now')}</button>
                        <button disabled={busy} onClick={() => run(() => syncSet(false))}>{t('Turn off sync')}</button>
                      </>
                    ) : (
                      <button className="primary" disabled={busy} onClick={() => run(() => syncSet(true))}>{t('Turn on sync for this vault')}</button>
                    )}
                    <button className="danger" disabled={busy} onClick={() => run(accountLogout)}>{t('Sign out')}</button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
