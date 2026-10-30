import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { vaultAdd, vaultCreate, vaultForget, vaultList, vaultLocate, vaultOpen, type VaultEntry } from './db'
import { explain } from './vaultErrors'
import { updateSettings, useSettings } from './settings'
import { t } from './i18n'

const pickFolder = async (title: string) => {
  const dir = await open({ directory: true, multiple: false, title })
  return typeof dir === 'string' ? dir : null
}

/** Shown when no vault is open: the first run, or after “All workspaces…”. The user always chooses where a vault lives. */
export function VaultPicker({ onOpened }: { onOpened: () => void }) {
  const lang = useSettings().lang
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setVaults((await vaultList()).vaults)
  }, [])
  useEffect(() => void refresh(), [refresh])

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await f()
    } catch (e) {
      setError(explain(e))
    } finally {
      try { await refresh() } catch (e) { setError(previous => previous || explain(e)) }
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
  const locate = (v: VaultEntry) =>
    run('locate' + v.id, async () => {
      const dir = await pickFolder(t('Choose the folder of “{name}”', { name: v.name }))
      if (!dir) return
      await vaultLocate(v.id, dir)
      await refresh()
    })

  const firstRun = vaults.length === 0

  return (
    <div className="overlay picker">
      <div className="modal backup-modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div>
            <b>{firstRun ? t('Welcome to Nevis') : t('Choose a vault')}</b>
            <small>{t('A vault is a folder that holds all the pages, images and history of one workspace.')}</small>
          </div>
          <div className="segmented acct-lang" role="group" aria-label={t('Interface language')}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => updateSettings({ lang: 'en' })}>English</button>
            <button className={lang === 'fa' ? 'on' : ''} onClick={() => updateSettings({ lang: 'fa' })} lang="fa">فارسی</button>
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
                      <b dir="auto">{v.name}</b>
                      <small dir="ltr" style={{ display: 'block', opacity: 0.7 }}>{v.path}</small>
                      {v.status === 'missing' && <small className="backup-warn">{t('Folder not found')}</small>}
                      {v.status === 'mismatch' && <small className="backup-warn">{t('A different vault is in this folder.')}</small>}
                    </div>
                    <span>
                      {v.status !== 'ok' && <button disabled={!!busy} onClick={() => locate(v)}>{t('Locate folder…')}</button>}
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
            <button className="primary" disabled={!!busy} onClick={() => void create()}>{t('Choose location and create…')}</button>
          </div>
          <div className="backup-acts">
            <button disabled={!!busy} onClick={openExisting}>{t('Open a folder as vault…')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
