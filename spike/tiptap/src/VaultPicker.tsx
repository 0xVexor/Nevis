import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { accountLogin, accountStatus, cloudDownload, cloudVaults, vaultAdd, vaultCreate, vaultForget, vaultList, vaultOpen, type AccountStatus, type CloudVault, type VaultEntry } from './db'
import * as Ic from './icons'
import { t } from './i18n'

const pickFolder = async (title: string) => {
  const dir = await open({ directory: true, multiple: false, title })
  return typeof dir === 'string' ? dir : null
}

const explain = (e: unknown) => (String(e) === 'NOT_CONFIGURED' ? t('Google sign-in is not set up in this build of the app.') : String(e))

/** Shown when no vault is open: first run, or after “Switch vault”. The user always chooses where a vault lives. */
export function VaultPicker({ onOpened }: { onOpened: () => void }) {
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [acc, setAcc] = useState<AccountStatus | null>(null)
  const [cloud, setCloud] = useState<CloudVault[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setVaults((await vaultList()).vaults)
    setAcc(await accountStatus())
  }, [])
  useEffect(() => void refresh(), [refresh])
  useEffect(() => {
    if (!acc?.email) return setCloud(null)
    cloudVaults().then(setCloud, (e) => (setCloud([]), setError(explain(e))))
  }, [acc?.email])

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await f()
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy('')
    }
  }

  const create = () =>
    run('create', async () => {
      const parent = await pickFolder(t('Choose where to create the vault'))
      if (!parent) return
      await vaultCreate(parent, name || t('My notes'))
      onOpened()
    })
  const openExisting = () =>
    run('add', async () => {
      const dir = await pickFolder(t('Choose a vault folder'))
      if (!dir) return
      await vaultAdd(dir)
      onOpened()
    })
  const signIn = () =>
    run('login', async () => {
      await accountLogin()
      await refresh()
    })
  const download = (v: CloudVault) =>
    run('dl' + v.id, async () => {
      const parent = await pickFolder(t('Choose where to put this vault on this computer'))
      if (!parent) return
      await cloudDownload(v.id, v.name, parent)
      onOpened()
    })

  return (
    <div className="overlay picker">
      <div className="modal backup-modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div>
            <b>{t('Choose a vault')}</b>
            <small>{t('A vault is a folder that holds all the pages, images and history of one workspace.')}</small>
          </div>
        </div>
        <div className="backup-body">
          {error && <p className="backup-warn" dir="auto">{error}</p>}

          {vaults.length > 0 && (
            <>
              <h4>{t('Your vaults')}</h4>
              <ul className="vault-list">
                {vaults.map((v) => (
                  <li key={v.id}>
                    <div>
                      <b dir="auto">{v.name}</b> {v.sync && <small className="vp-cloud"><Ic.Cloud size={13} /></small>}
                      <small dir="ltr" style={{ display: 'block', opacity: 0.7 }}>{v.path}</small>
                      {!v.exists && <small className="backup-warn">{t('Folder not found')}</small>}
                    </div>
                    <span>
                      <button className="primary" disabled={!v.exists || !!busy} onClick={() => run('open', async () => (await vaultOpen(v.id), onOpened()))}>{t('Open')}</button>
                      <button disabled={!!busy} title={t('Remove from the list (files stay on disk)')} onClick={() => run('forget', async () => (await vaultForget(v.id), refresh()))}>✕</button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>{t('Create a new vault')}</h4>
          <div className="backup-acts">
            <input dir="auto" placeholder={t('Vault name')} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" disabled={!!busy} onClick={create}>{t('Choose location and create…')}</button>
          </div>
          <div className="backup-acts">
            <button disabled={!!busy} onClick={openExisting}>{t('Open a folder as vault…')}</button>
          </div>

          <h4>{t('Your cloud vaults')}</h4>
          {!acc?.email ? (
            <div className="backup-acts">
              <button disabled={!!busy || acc?.configured === false} onClick={signIn}>{busy === 'login' ? t('Waiting for the browser…') : t('Sign in with Google')}</button>
              {acc?.configured === false && <small className="backup-warn">{t('Google sign-in is not set up in this build of the app.')}</small>}
            </div>
          ) : (
            <>
              <small dir="ltr">{acc.email}</small>
              {cloud === null ? <p>{t('Loading…')}</p> : cloud.length === 0 ? <p>{t('No other vaults in this account.')}</p> : (
                <ul className="vault-list">
                  {cloud.map((v) => (
                    <li key={v.id}>
                      <b dir="auto">{v.name}</b>
                      <button className="primary" disabled={!!busy} onClick={() => download(v)}>{busy === 'dl' + v.id ? t('Downloading…') : t('Download to this computer…')}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
