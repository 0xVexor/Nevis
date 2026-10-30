import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { switchWorkspaceSafely } from './workspaceSwitch'
import { saveWorkspace } from './saveWorkspace'
import {
  freezeStorage, isTauri, thawStorage,
  vaultAdd, vaultClose, vaultCreate, vaultForget, vaultInfo, vaultList, vaultLocate, vaultOpen, vaultRename, vaultTrashLocal,
  type VaultEntry,
} from './db'
import { alertDialog, confirmDialog, promptDialog } from './dialog'
import { explain } from './vaultErrors'
import * as Ic from './icons'
import { t } from './i18n'

const pickFolder = async (title: string) => {
  const dir = await open({ directory: true, multiple: false, title })
  return typeof dir === 'string' ? dir : null
}

/**
 * Workspaces dialog: every vault of this device with its state and what can be done with it (switch, rename, locate,
 * remove, delete).
 * Nothing destructive happens without its own confirmation, and what it does is said in that confirmation:
 * removing from the list and moving the folder to the Recycle Bin are different things.
 */
export function Vaults({ onClose, onNew }: { onClose: () => void; onNew: (create: (name: string) => Promise<void>) => void }) {
  const [id, setId] = useState('')
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [menu, setMenu] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reloadVaults = useCallback(() => (isTauri ? vaultList().then((l) => setVaults(l.vaults), () => {}) : Promise.resolve()), [])

  useEffect(() => {
    if (!isTauri) return
    void vaultInfo().then((v) => setId(v.id), () => {}) // fails when the open vault's folder vanished: then no row is "current"
    void reloadVaults()
  }, [reloadVaults])
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
      void reloadVaults()
    }
  }

  /** Leaves the workspace that is open: nothing may stay unsaved in it, and nothing may be written into the next one. */
  const switching = (action: () => Promise<unknown>) => switchWorkspaceSafely(action, { save: saveWorkspace, freeze: freezeStorage, thaw: thawStorage, opened: () => window.location.reload() })

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
  /** The picker of all workspaces. */
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
        message: t('The folder and its files stay on this computer. You can open the folder again later.'),
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
        t('The folder with all its pages and images is moved to the Recycle Bin of this computer. Type the name of the workspace to confirm.'),
        t('Move to Recycle Bin'),
      )
      if (!ok) return
      if (v.id === id) await switching(() => vaultTrashLocal(v.id))
      else await vaultTrashLocal(v.id)
    })
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

        </div>
      </div>
    </div>
  )
}
