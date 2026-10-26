import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  accountStatus, cloudDelete, cloudDownload, cloudReupload, cloudVaults, freezeStorage, isTauri, syncConfirm, syncNow, syncSet, thawStorage,
  vaultAdd, vaultClose, vaultCreate, vaultForget, vaultInfo, vaultList, vaultLocate, vaultOpen, vaultRename, vaultTrashLocal,
  type AccountStatus, type CloudVault, type VaultEntry,
} from './db'
import { repo } from './store'
import { alertDialog, confirmDialog, promptDialog } from './dialog'
import { explain } from './vaultErrors'
import { syncLabel } from './Account'
import * as Ic from './icons'
import { locale, t } from './i18n'

const when = (ts: number) => (ts ? new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('Not yet'))

const pickFolder = async (title: string) => {
  const dir = await open({ directory: true, multiple: false, title })
  return typeof dir === 'string' ? dir : null
}

/**
 * Workspaces dialog: every vault of this device with its state and what can be done with it (switch, rename, locate,
 * remove, delete), the vaults of the account that are not here yet, and the sync of the open vault.
 * Nothing destructive happens without its own confirmation, and what it does is said in that confirmation:
 * removing from the list, moving the folder to the Recycle Bin and deleting the cloud copy are three different things.
 */
export function Vaults({ onClose, onNew, onAccount }: { onClose: () => void; onNew: (create: (name: string) => Promise<void>) => void; onAccount: () => void }) {
  const [id, setId] = useState('')
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [acc, setAcc] = useState<AccountStatus | null>(null)
  const [cloud, setCloud] = useState<CloudVault[] | null>(null)
  const [menu, setMenu] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => (isTauri ? accountStatus().then(setAcc, () => {}) : Promise.resolve()), [])
  const reloadVaults = useCallback(() => (isTauri ? vaultList().then((l) => setVaults(l.vaults), () => {}) : Promise.resolve()), [])
  const signedIn = !!acc?.signedIn
  const reloadCloud = useCallback(() => {
    if (!signedIn) return setCloud(null)
    cloudVaults().then(setCloud, (e) => (setCloud([]), setError(explain(e))))
  }, [signedIn])

  useEffect(() => {
    if (!isTauri) return
    void vaultInfo().then((v) => setId(v.id), () => {}) // fails when the open vault's folder vanished: then no row is "current"
    void reloadVaults()
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh, reloadVaults])
  useEffect(() => reloadCloud(), [reloadCloud])
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
      setError(explain(e))
    } finally {
      setBusy(false)
      setMenu('')
      void refresh()
      void reloadVaults()
      reloadCloud()
    }
  }

  /** Leaves the workspace that is open: nothing may stay unsaved in it, and nothing may be written into the next one. */
  const switching = async (f: () => Promise<unknown>) => {
    await repo.flushed()
    freezeStorage()
    try {
      await f()
    } catch (e) {
      thawStorage() // it did not happen: the workspace stays as it was
      throw e
    }
    window.location.reload()
  }

  const switchTo = (to: string) => run(() => (to === id ? Promise.resolve() : switching(() => vaultOpen(to))))
  const create = async (vaultName: string) => {
    const parent = await pickFolder(t('Choose where to create the vault'))
    if (!parent) return
    await switching(() => vaultCreate(parent, vaultName))
  }
  const openFolder = () =>
    run(async () => {
      const dir = await pickFolder(t('Choose a vault folder'))
      if (dir) await switching(() => vaultAdd(dir))
    })
  const download = (v: CloudVault) =>
    run(async () => {
      const parent = await pickFolder(t('Choose where to put this vault on this computer'))
      if (parent) await switching(() => cloudDownload(v.id, v.name, parent))
    })
  /** The picker of all workspaces (it also shows the account's cloud vaults). */
  const toPicker = () => run(() => switching(() => vaultClose()))

  const locate = (v: VaultEntry) =>
    run(async () => {
      const dir = await pickFolder(t('Choose the folder of “{name}”', { name: v.name }))
      if (!dir) return
      await vaultLocate(v.id, dir)
      if (v.id === id) await switching(() => vaultOpen(v.id)) // the open workspace points at the old place until it is opened again
    })
  const rename = (v: VaultEntry) =>
    run(async () => {
      const name = await promptDialog({ title: t('Rename workspace'), initial: v.name, confirmLabel: t('Save') })
      if (name?.trim() && name.trim() !== v.name) await vaultRename(v.id, name.trim())
    })

  /** Destructive steps ask for the name of the workspace, so that they are never a slip of the finger. */
  const confirmByName = async (v: VaultEntry, title: string, message: string, label: string) => {
    const typed = await promptDialog({ title, message, danger: true, confirmLabel: label, placeholder: v.name })
    if (typed === null) return false
    if (typed.trim() !== v.name) {
      await alertDialog({ title: t('The name did not match'), message: t('Nothing was changed.') })
      return false
    }
    return true
  }
  const forget = (v: VaultEntry) =>
    run(async () => {
      const ok = await confirmDialog({
        title: t('Remove “{name}” from this list?', { name: v.name }),
        message: t('The folder and its files stay on this computer, and so does the cloud copy. You can open the folder again later.'),
        confirmLabel: t('Remove from list'),
      })
      if (!ok) return
      if (v.id === id) await switching(() => vaultForget(v.id))
      else await vaultForget(v.id)
    })
  const trashLocal = (v: VaultEntry) =>
    run(async () => {
      const ok = await confirmByName(
        v,
        t('Move “{name}” to the Recycle Bin?', { name: v.name }),
        t('The folder with all its pages and images is moved to the Recycle Bin of this computer. The cloud copy stays. Type the name of the workspace to confirm.'),
        t('Move to Recycle Bin'),
      )
      if (!ok) return
      if (v.id === id) await switching(() => vaultTrashLocal(v.id))
      else await vaultTrashLocal(v.id)
    })
  const deleteCloud = (v: VaultEntry) =>
    run(async () => {
      const ok = await confirmByName(
        v,
        t('Delete the cloud copy of “{name}”?', { name: v.name }),
        t('The cloud copy goes to the server trash, where you can bring it back for 30 days, and is not synced any more. The files on this computer stay, and other devices keep their local copies. Type the name of the workspace to confirm.'),
        t('Delete cloud copy'),
      )
      if (ok) await cloudDelete(v.id)
    })
  const deleteEverywhere = (v: VaultEntry) =>
    run(async () => {
      const ok = await confirmByName(
        v,
        t('Delete “{name}” everywhere?', { name: v.name }),
        t('The cloud copy goes to the server trash (30 days) and the folder on this computer to the Recycle Bin. Other devices keep their local copies. Type the name of the workspace to confirm.'),
        t('Delete everywhere'),
      )
      if (!ok) return
      if (signedIn) await cloudDelete(v.id)
      if (v.id === id) await switching(() => vaultTrashLocal(v.id))
      else await vaultTrashLocal(v.id)
    })

  const paused = acc?.syncOn && acc.state === 'paused' ? acc.reason : ''
  const here = new Set(vaults.filter((v) => v.status === 'ok').map((v) => v.id))
  const elsewhere = (cloud ?? []).filter((c) => !here.has(c.id))
  const rowState = (v: VaultEntry) => (v.id === id ? t('Current workspace') : v.status === 'ok' ? t('Switch') : '')

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wsd" role="dialog" aria-modal="true" aria-label={t('Workspaces')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wsd-head">
          <b>{t('Workspaces')}</b>
          <button className="icon-btn" title={t('Close  Esc')} onClick={onClose}><Ic.Close size={16} /></button>
        </div>

        <div className="wsd-body">
          {error && <p className="backup-warn" dir="auto">{error}</p>}
          <div className="wsd-list">
            {isTauri ? (
              vaults.map((v) => (
                <div key={v.id} className="wsd-item">
                  <div className={'wsd-row' + (v.id === id ? ' cur' : '')}>
                    <button className="wsd-main" disabled={busy || v.status !== 'ok'} onClick={() => void switchTo(v.id)}>
                      <span className="wsd-ic"><Ic.Layers size={17} /></span>
                      <span className="wsd-tx">
                        <b dir="auto">{v.name}</b>
                        <small dir={v.status === 'ok' ? 'ltr' : 'auto'} className={v.status === 'ok' ? '' : 'wsd-bad'}>
                          {v.status === 'missing' ? t('Folder not found') : v.status === 'mismatch' ? t('A different vault is in this folder.') : v.path}
                        </small>
                      </span>
                    </button>
                    {v.sync && <span className="wsd-cloud" title={t('Synced')}><Ic.Cloud size={14} /></span>}
                    <span className="wsd-state">{rowState(v)}</span>
                    <button className="wsd-more" disabled={busy} aria-label={t('Actions')} title={t('Actions')} aria-expanded={menu === v.id} onClick={() => setMenu(menu === v.id ? '' : v.id)}>⋯</button>
                  </div>
                  {menu === v.id && (
                    <div className="wsd-menu" role="menu">
                      {v.status === 'ok' && v.id !== id && <button role="menuitem" disabled={busy} onClick={() => void switchTo(v.id)}><Ic.Open size={16} />{t('Switch')}</button>}
                      {v.status === 'ok' && <button role="menuitem" disabled={busy} onClick={() => void rename(v)}><Ic.Pencil size={16} />{t('Rename…')}</button>}
                      {v.status !== 'ok' && <button role="menuitem" className="accent" disabled={busy} onClick={() => void locate(v)}><Ic.Folder size={16} />{t('Locate folder…')}</button>}
                      <button role="menuitem" disabled={busy} onClick={() => void forget(v)}><Ic.Close size={16} />{t('Remove from list')}</button>
                      <div className="wsd-sep" role="separator" />
                      {v.status === 'ok' && <button role="menuitem" className="danger" disabled={busy} onClick={() => void trashLocal(v)}><Ic.Trash size={16} />{t('Move folder to Recycle Bin…')}</button>}
                      {signedIn && <button role="menuitem" className="danger" disabled={busy} onClick={() => void deleteCloud(v)}><Ic.Cloud size={16} />{t('Delete cloud copy…')}</button>}
                      {v.status === 'ok' && <button role="menuitem" className="danger" disabled={busy} onClick={() => void deleteEverywhere(v)}><Ic.Trash size={16} />{t('Delete everywhere…')}</button>}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="wsd-row cur">
                <span className="wsd-ic"><Ic.Layers size={17} /></span>
                <span className="wsd-tx"><b>{t('Personal space')}</b></span>
                <span className="wsd-state">{t('Current workspace')}</span>
              </div>
            )}
          </div>

          {!isTauri && <p className="wsd-note">{t('Your notes live locally. This preview uses its own sample content, separate from your Nevis workspace.')}</p>}

          {isTauri && (
            <>
              <button className="wsd-new" disabled={busy} onClick={() => (onClose(), onNew(create))}>
                <span className="wsd-ic"><Ic.Plus size={16} /></span>{t('New workspace…')}
              </button>
              <div className="wsd-acts wsd-more-acts">
                <button disabled={busy} onClick={() => void openFolder()}>{t('Open a folder as vault…')}</button>
                <button disabled={busy} onClick={() => void toPicker()}>{t('All workspaces…')}</button>
              </div>
            </>
          )}

          {isTauri && elsewhere.length > 0 && (
            <section className="wsd-sync">
              <h4>{t('In your account, not on this computer')}</h4>
              <div className="wsd-list">
                {elsewhere.map((c) => (
                  <div key={c.id} className="wsd-row">
                    <span className="wsd-ic"><Ic.Cloud size={17} /></span>
                    <span className="wsd-tx"><b dir="auto">{c.name}</b></span>
                    <span className="wsd-acts"><button className="primary" disabled={busy} onClick={() => void download(c)}>{t('Download to this computer…')}</button></span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {isTauri && (
            <section className="wsd-sync">
              <h4>{t('Sync between devices')}</h4>
              {!acc?.signedIn ? (
                <div className="wsd-card">
                  <p>{t('Sign in and Nevis keeps this vault in sync on all your devices, within a second or two of each change. You need only a user name and a password: no email address.')}</p>
                  <button className="primary" disabled={busy} onClick={() => (onClose(), onAccount())}>{t('Sign in or create account')}</button>
                </div>
              ) : (
                <div className="wsd-card">
                  <dl className="wsd-info">
                    <dt>{t('Account')}</dt><dd dir="ltr">{acc.username}</dd>
                    <dt>{t('Sync this vault')}</dt><dd><i className={'wsd-dot ' + (acc.syncOn ? acc.state : 'off')} />{syncLabel(acc)}</dd>
                    <dt>{t('Last sync')}</dt><dd>{when(acc.lastAt)}</dd>
                  </dl>
                  {acc.syncOn && acc.state === 'offline' && <p className="backup-warn">{t('You are offline. Everything you write is saved on this device and goes to the server by itself when the connection is back.')}</p>}
                  {acc.state === 'error' && acc.error && <p className="backup-warn" dir="auto">{explain(acc.error)}</p>}
                  {paused === 'SIGNED_OUT' && <p className="backup-warn">{t('You are signed out of this device. Sign in again to keep syncing.')}</p>}
                  {paused === 'VAULT_MISSING' && <p className="backup-warn">{t('The vault folder was not found. Sync is paused and nothing in the cloud was changed. Use “Locate folder…” in the list above.')}</p>}
                  {paused === 'VAULT_MISMATCH' && <p className="backup-warn">{t('A different vault is in the folder of this workspace. Sync is paused and nothing was changed.')}</p>}
                  {paused === 'CLOUD_GONE' && <p className="backup-warn">{t('The cloud copy of this vault is gone (deleted from another device or from the server). Your files here are untouched.')}</p>}
                  {paused === 'NEEDS_CONFIRM' && <p className="backup-warn">{t('{n} files would be deleted by this sync. If you deleted them on purpose, confirm; otherwise turn sync off and check the folder.', { n: acc.error })}</p>}
                  {!acc.syncOn && elsewhere.length > 0 && (
                    <p className="backup-warn">{t('Your account already has other vaults in the cloud (listed above). To get one of them on this computer, download it. Turning on sync here makes a separate cloud copy of this vault.')}</p>
                  )}
                  <div className="wsd-acts">
                    {acc.syncOn ? (
                      <>
                        {paused === 'SIGNED_OUT' && <button className="primary" disabled={busy} onClick={() => (onClose(), onAccount())}>{t('Sign in again')}</button>}
                        {paused === 'CLOUD_GONE' && <button className="primary" disabled={busy} onClick={() => void run(() => cloudReupload(id))}>{t('Upload this vault again')}</button>}
                        {paused === 'NEEDS_CONFIRM' && <button className="primary" disabled={busy} onClick={() => void run(syncConfirm)}>{t('Yes, delete them')}</button>}
                        <button disabled={busy} onClick={() => void run(syncNow)}><Ic.Cloud size={15} />{t('Sync now')}</button>
                        <button disabled={busy} onClick={() => void run(() => syncSet(false))}>{t('Turn off sync')}</button>
                      </>
                    ) : (
                      <button className="primary" disabled={busy} onClick={() => void run(() => syncSet(true))}>{t('Turn on sync for this vault')}</button>
                    )}
                    <button disabled={busy} onClick={() => (onClose(), onAccount())}>{t('Manage account…')}</button>
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
