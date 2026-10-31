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
import { Icon } from './design-system'
import { MenuItem, MenuSep, Popover } from './ui'
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
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null)
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
      setMenuAt(null)
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
  const menuVault = vaults.find((v) => v.id === menu)

  const closeMenu = () => (setMenu(''), setMenuAt(null))
  const card = (v: VaultEntry) => (
    <div key={v.id} className={'wsd-card' + (v.id === id ? ' cur' : '')}>
      <div className="wsd-card-top">
        <span className="wsd-logo">{(v.name.trim()[0] ?? 'N').toUpperCase()}</span>
        <div className="wsd-tx">
          <b dir="auto">{v.name}</b>
          <small dir={v.status === 'ok' ? 'ltr' : 'auto'} className={v.status === 'ok' ? '' : 'wsd-bad'} title={v.path}>
            {v.status === 'missing' ? t('Folder not found') : v.status === 'mismatch' ? t('A different vault is in this folder.') : v.path}
          </small>
        </div>
        <button className="icon-btn wsd-more" disabled={busy} aria-label={t('Actions')} title={t('Actions')} aria-expanded={menu === v.id} onClick={(e) => (setMenu(v.id), setMenuAt(e.currentTarget.getBoundingClientRect()))}><Icon name="more-horizontal" /></button>
      </div>
      <div className="wsd-card-foot">
        {v.id === id ? <span className="ds-chip ds-chip--dot" style={{ ['--c' as string]: 'var(--ds-accent)' }}>{t('Current workspace')}</span>
          : v.status === 'ok' ? <button className="ds-btn ds-btn--sm" disabled={busy} onClick={() => void switchTo(v.id)}>{t('Switch')}</button>
          : <button className="ds-btn ds-btn--sm" disabled={busy} onClick={() => void locate(v)}><Icon name="folder" size={15} />{t('Locate folder…')}</button>}
      </div>
    </div>
  )

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wsd" role="dialog" aria-modal="true" aria-label={t('Workspaces')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wsd-head">
          <div>
            <b>{t('Workspaces')}</b>
            <small>{t('Each workspace is a folder you own. Switch any time.')}</small>
          </div>
          <span className="wsd-head-acts">
            {isTauri && <button className="ds-btn" disabled={busy} onClick={() => void openFolder()}><Icon name="folder" size={16} />{t('Open a folder as vault…')}</button>}
            {isTauri && <button className="ds-btn ds-btn--primary" disabled={busy} onClick={() => (onClose(), onNew(create))}><Icon name="plus" size={16} />{t('New workspace…')}</button>}
            <button className="icon-btn" title={t('Close  Esc')} onClick={onClose}><Ic.Close size={16} /></button>
          </span>
        </div>

        <div className="wsd-body">
          {error && <p className="backup-warn" dir="auto">{error}</p>}
          <div className="wsd-grid">
            {isTauri ? vaults.map(card) : (
              <div className="wsd-card cur">
                <div className="wsd-card-top">
                  <span className="wsd-logo">P</span>
                  <div className="wsd-tx"><b>{t('Personal space')}</b></div>
                </div>
                <div className="wsd-card-foot"><span className="ds-chip ds-chip--dot" style={{ ['--c' as string]: 'var(--ds-accent)' }}>{t('Current workspace')}</span></div>
              </div>
            )}
            {isTauri && (
              <button className="wsd-card wsd-add" disabled={busy} onClick={() => (onClose(), onNew(create))}>
                <Icon name="plus" size={22} /><b>{t('New workspace…')}</b>
              </button>
            )}
          </div>

          {!isTauri && <p className="wsd-note">{t('Your notes live locally. This preview uses its own sample content, separate from your Nevis workspace.')}</p>}
          {isTauri && <p className="wsd-note">{t('Removing a workspace from the list never deletes its files.')}</p>}
          {isTauri && <button className="wsd-link" disabled={busy} onClick={() => void toPicker()}>{t('All workspaces…')}</button>}
        </div>
      </div>
      {menuVault && menuAt && (
        <Popover anchor={menuAt} align="end" onClose={closeMenu}>
          <div className="ds-menu" onMouseDown={(e) => e.stopPropagation()}>
            {menuVault.status === 'ok' && menuVault.id !== id && <MenuItem icon={<Ic.Open size={16} />} label={t('Switch')} onClick={() => void switchTo(menuVault.id)} />}
            {menuVault.status === 'ok' && <MenuItem icon={<Ic.Pencil size={16} />} label={t('Rename…')} onClick={() => void rename(menuVault)} />}
            {menuVault.status !== 'ok' && <MenuItem icon={<Ic.Folder size={16} />} label={t('Locate folder…')} onClick={() => void locate(menuVault)} />}
            <MenuItem icon={<Ic.Close size={16} />} label={t('Remove from list')} onClick={() => void forget(menuVault)} />
            {menuVault.status === 'ok' && <><MenuSep /><MenuItem danger icon={<Ic.Trash size={16} />} label={t('Move folder to Recycle Bin…')} onClick={() => void trashLocal(menuVault)} /></>}
          </div>
        </Popover>
      )}
    </div>
  )
}
