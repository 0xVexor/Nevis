import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listCloudWorkspaces, downloadCloudWorkspace, createDriveWorkspace, type RemoteWorkspace } from './workspaceCloud'
import { vaultAdd, vaultCreate, vaultForget, vaultList, vaultLocate, vaultOpen, type VaultEntry } from './db'
import { AccountDialog, AuthFlow, size, useAccountStatus } from './Account'
import { explain } from './vaultErrors'
import { updateSettings, useSettings } from './settings'
import * as Ic from './icons'
import { t } from './i18n'

const pickFolder = async (title: string) => {
  const dir = await open({ directory: true, multiple: false, title })
  return typeof dir === 'string' ? dir : null
}

/**
 * Shown when no vault is open: the first run, or after “All workspaces…”. The user always chooses where a vault lives.
 * Signing in is optional and comes first only when nothing is here yet, because that is what someone who already
 * uses Nevis on another device wants: their notes, here.
 */
export function VaultPicker({ onOpened }: { onOpened: () => void }) {
  const lang = useSettings().lang
  const [acc, refreshAcc] = useAccountStatus(3000)
  const [view, setView] = useState<'home' | 'auth'>('home')
  const [accountOpen, setAccountOpen] = useState(false)
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [cloud, setCloud] = useState<RemoteWorkspace[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setVaults((await vaultList()).vaults)
    await refreshAcc()
  }, [refreshAcc])
  useEffect(() => void refresh(), [refresh])

  const signedIn = !!acc?.signedIn
  // a vault that is on this device with its folder in place is not offered for download; one whose folder is gone is
  const elsewhere = (cloud ?? []).filter((c) => !vaults.some((v) => v.id === c.id && v.status === 'ok'))
  useEffect(() => {
    if (!signedIn) return setCloud(null)
    listCloudWorkspaces(acc?.provider, invoke).then(setCloud, (e) => (setCloud([]), setError(explain(e))))
  }, [signedIn, acc?.provider])

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

  const create = (localOnly = false) =>
    run('create', async () => {
      const parent = await pickFolder(t('Choose where to create the vault'))
      if (!parent) return
      if (acc?.provider === 'drive' && !localOnly) await createDriveWorkspace(name.trim() || t('My notes'), async () => parent, invoke)
      else await vaultCreate(parent, name || t('My notes'))
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
  const download = (v: RemoteWorkspace) =>
    run('dl' + v.id, async () => {
      const parent = await pickFolder(t('Choose where to put this vault on this computer'))
      if (!parent) return
      await downloadCloudWorkspace(acc?.provider, v, parent, invoke)
      onOpened()
    })

  const firstRun = vaults.length === 0 && !signedIn
  const syncCard = (
    <div className="acct-invite">
      <span className="acct-hero-ic"><Ic.Cloud size={20} /></span>
      <div>
        <b>{firstRun ? t('Already use Nevis on another device?') : t('Keep your notes in sync')}</b>
        <small>{t('Sign in to get your notes here and keep every device up to date. It is optional: your notes live in a folder on this computer either way.')}</small>
      </div>
      <button className="primary" disabled={!!busy} onClick={() => setAccountOpen(true)}>{t('Sign in or create account')}</button>
    </div>
  )

  return (
    <div className="overlay picker">
      <div className="modal backup-modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div>
            <b>{view === 'auth' ? t('Account and sync') : firstRun ? t('Welcome to Nevis') : t('Choose a vault')}</b>
            <small>{view === 'auth' ? t('Your notes stay in a folder on this computer; the account only keeps your devices in step.') : t('A vault is a folder that holds all the pages, images and history of one workspace.')}</small>
          </div>
          <div className="segmented acct-lang" role="group" aria-label={t('Interface language')}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => updateSettings({ lang: 'en' })}>English</button>
            <button className={lang === 'fa' ? 'on' : ''} onClick={() => updateSettings({ lang: 'fa' })} lang="fa">فارسی</button>
          </div>
        </div>

        <div className="backup-body">
          {view === 'auth' ? (
            <AuthFlow
              status={acc}
              initial="signin"
              onBack={() => setView('home')}
              onDone={() => {
                setView('home')
                void refresh()
              }}
            />
          ) : (
            <>
              {error && <p className="backup-warn" dir="auto">{error}</p>}

              {signedIn && acc && (
                <button className="acct-chip" onClick={() => setAccountOpen(true)} title={t('Account')}>
                  <span className="acct-avatar" aria-hidden="true">{(acc.username ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className="acct-chip-tx"><b dir="ltr">{acc.username}</b><small>{t('Signed in · manage account')}</small></span>
                  <Ic.Chevron size={14} />
                </button>
              )}

              {firstRun && syncCard}

              {vaults.length > 0 && (
                <>
                  <h4>{t('Your vaults')}</h4>
                  <ul className="vault-list">
                    {vaults.map((v) => (
                      <li key={v.id}>
                        <div>
                          <b dir="auto">{v.name}</b> {v.sync && <small className="vp-cloud"><Ic.Cloud size={13} /></small>}
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

              {signedIn && (
                <>
                  <h4>{t('In your account, not on this computer')}</h4>
                  {cloud === null ? (
                    <p>{t('Loading…')}</p>
                  ) : elsewhere.length === 0 ? (
                    <p className="acct-meta">{t('No other vaults in this account.')}</p>
                  ) : (
                    <ul className="vault-list">
                      {elsewhere.map((v) => (
                        <li key={v.id}>
                          <div>
                            <b dir="auto">{v.name}</b>
                            {typeof v.bytes === 'number' && <small style={{ display: 'block', opacity: 0.7 }}>{t('{files} files · {size}', { files: v.files ?? 0, size: size(v.bytes) })}</small>}
                          </div>
                          <button className="primary" disabled={!!busy} onClick={() => download(v)}>{busy === 'dl' + v.id ? t('Downloading…') : t('Download to this computer…')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              <h4>{t(acc?.provider === 'drive' ? 'Create a workspace in Google Drive' : 'Create a new vault')}</h4>
              <div className="backup-acts">
                <input dir="auto" placeholder={t('Vault name')} value={name} onChange={(e) => setName(e.target.value)} />
                <button className="primary" disabled={!!busy} onClick={() => void create()}>{t(acc?.provider === 'drive' ? 'Create and open workspace' : 'Choose location and create…')}</button>
              </div>
              <div className="backup-acts">
                {acc?.provider === 'drive' && <button disabled={!!busy} onClick={() => void create(true)}>{t('Create a local-only workspace')}</button>}
                <button disabled={!!busy} onClick={openExisting}>{t('Open a folder as vault…')}</button>
              </div>

              {!firstRun && !signedIn && syncCard}
            </>
          )}
        </div>
      </div>
      {accountOpen && (
        <AccountDialog
          onWorkspaceOpened={onOpened}
          onClose={() => {
            setAccountOpen(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
