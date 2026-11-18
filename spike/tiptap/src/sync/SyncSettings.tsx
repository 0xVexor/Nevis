// Settings → Sync: sign in to the person's own Nevis server, turn sync on for the open workspace, see what it is doing,
// bring a workspace from the server to this device, and manage devices. Desktop only. The engine decides what moves;
// this page only asks for things and tells what happened.
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, Field, Notice, PreferenceGroup, PreferenceRow } from '../design-system'
import { Switch } from '../design-system/controls'
import { isTauri } from '../db'
import { t } from '../i18n'
import {
  accountChangePassword,
  accountDelete,
  accountInfo,
  accountLogin,
  accountLogout,
  accountNewRecoveryKey,
  accountRecover,
  accountRegister,
  accountRevokeDevice,
  accountStatus,
  cloudDelete,
  cloudDownload,
  cloudPurge,
  cloudRestore,
  cloudTrashed,
  cloudVaults,
  formatBytes,
  saveRecoveryKeyFile,
  serverHealth,
  syncConfirm,
  syncError,
  syncHeld,
  syncNow,
  syncSet,
  type AccountInfo,
  type HeldDelete,
  type ServerHealth,
  type ServerVault,
  type SyncStatus,
  type TrashedVault,
} from './client'

const HELD_SHOWN = 10

function statusText(s: SyncStatus): string {
  if (!s.syncOn) return t('Sync is off for this workspace.')
  switch (s.state) {
    case 'syncing':
      return t('Syncing…')
    case 'pending':
      return t('Waiting to sync…')
    case 'offline':
      return t('Offline. It will try again by itself.')
    case 'idle':
      return s.lastAt ? t('Up to date. Last sync: {time}').replace('{time}', new Date(s.lastAt).toLocaleTimeString()) : t('Up to date.')
    case 'paused':
      if (s.reason === 'NEEDS_CONFIRM') return t('{n} deletions are waiting for your OK.').replace('{n}', s.error)
      if (s.reason === 'SIGNED_OUT') return t('You are signed out of the server. Sign in again.')
      return syncError(s.reason)
    case 'error':
      return syncError(s.error)
    default:
      return t('Sync is off for this workspace.')
  }
}

/** The recovery key is shown once; it is the only way back in after a forgotten password. */
function RecoveryKeyDialog({ keyText, username, onClose }: { keyText: string; username: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const saveFile = async () => {
    try {
      if (await saveRecoveryKeyFile(username, keyText)) setNote(t('Saved.'))
    } catch (e) {
      setNote(syncError(e))
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keyText)
      setNote(t('Copied.'))
    } catch {
      setNote(t('Copying did not work. Select the key and copy it by hand.'))
    }
  }
  return (
    <Dialog
      open
      title={t('Your recovery key')}
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('I have saved it')}
        </Button>
      }
    >
      <div className="ds-modal-body">
        <p>{t('If you forget your password, this key is the only way back into your account. It is shown once. Keep it somewhere safe, outside this computer.')}</p>
        <p>
          <code dir="ltr" style={{ userSelect: 'all', wordBreak: 'break-all' }}>
            {keyText}
          </code>
        </p>
        <p>
          <Button onClick={() => void saveFile()}>{t('Save to a file')}</Button> <Button onClick={() => void copy()}>{t('Copy')}</Button>
        </p>
        {note && <p role="status">{note}</p>}
      </div>
    </Dialog>
  )
}

function SignIn({ status, onDone, onKey }: { status: SyncStatus; onDone: () => void; onKey: (key: string, username: string) => void }) {
  const [server, setServer] = useState(status.server || '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [recover, setRecover] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try {
      await job()
    } catch (e) {
      setMessage(syncError(e))
    } finally {
      setBusy(false)
    }
  }
  const check = () =>
    run(async () => {
      setHealth(await serverHealth(server))
    })
  const signIn = () =>
    run(async () => {
      await accountLogin(server, username, password)
      onDone()
    })
  const register = () =>
    run(async () => {
      const key = await accountRegister(server, username, password, invite)
      onKey(key, username)
      onDone()
    })
  const recoverNow = () =>
    run(async () => {
      const key = await accountRecover(server, username, recoveryKey, password)
      onKey(key, username)
      onDone()
    })
  const registration = health?.registration
  return (
    <PreferenceGroup title={t('Your server')} hint={t('Sync keeps your workspaces the same on all your devices, through a server that you run. Nothing goes anywhere else.')}>
      <Notice tone="info" title={t('Sign in to send this workspace to your server')}>
        {t('This workspace is only on this computer. After you sign in, you can send it to your server and keep it synced.')}
      </Notice>
      <PreferenceRow wide label={t('Server address')} hint={t('For example sync.example.com')}>
        <Field ltr value={server} placeholder="sync.example.com" aria-label={t('Server address')} onChange={(e) => setServer(e.target.value)} onBlur={() => server.trim() && void check()} />
      </PreferenceRow>
      <PreferenceRow wide label={t('User name')}>
        <Field ltr value={username} autoComplete="username" aria-label={t('User name')} onChange={(e) => setUsername(e.target.value)} />
      </PreferenceRow>
      <PreferenceRow wide label={recover ? t('New password') : t('Password')}>
        <Field
          ltr
          type="password"
          value={password}
          autoComplete={recover ? 'new-password' : 'current-password'}
          aria-label={recover ? t('New password') : t('Password')}
          onChange={(e) => setPassword(e.target.value)}
        />
      </PreferenceRow>
      {recover && (
        <PreferenceRow wide label={t('Recovery key')} hint={t('The key you saved when you made the account.')}>
          <Field ltr value={recoveryKey} aria-label={t('Recovery key')} onChange={(e) => setRecoveryKey(e.target.value)} />
        </PreferenceRow>
      )}
      {!recover && registration === 'invite' && (
        <PreferenceRow wide label={t('Invite code')} hint={t('This server takes new accounts only with a code from its owner.')}>
          <Field ltr value={invite} aria-label={t('Invite code')} onChange={(e) => setInvite(e.target.value)} />
        </PreferenceRow>
      )}
      {message && (
        <Notice tone="bad" role="alert">
          {message}
        </Notice>
      )}
      <PreferenceRow wide label="">
        {recover ? (
          <>
            <Button variant="primary" disabled={busy || !server || !username || !password || !recoveryKey} onClick={() => void recoverNow()}>
              {t('Set the new password')}
            </Button>{' '}
            <Button disabled={busy} onClick={() => setRecover(false)}>
              {t('Back')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy || !server || !username || !password} onClick={() => void signIn()}>
              {t('Sign in')}
            </Button>{' '}
            {registration !== 'closed' && (
              <Button disabled={busy || !server || !username || !password} onClick={() => void register()}>
                {t('Create account')}
              </Button>
            )}{' '}
            <Button variant="ghost" disabled={busy} onClick={() => setRecover(true)}>
              {t('Forgot password')}
            </Button>
          </>
        )}
      </PreferenceRow>
      {registration === 'closed' && <p className="prefs-note">{t('This server does not take new accounts.')}</p>}
    </PreferenceGroup>
  )
}

function SignedIn({ status, refresh, onKey }: { status: SyncStatus; refresh: () => void; onKey: (key: string, username: string) => void }) {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [vaults, setVaults] = useState<ServerVault[] | null>(null)
  const [trashed, setTrashed] = useState<TrashedVault[]>([])
  const [held, setHeld] = useState<HeldDelete[]>([])
  const [deleting, setDeleting] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [removing, setRemoving] = useState<ServerVault | null>(null)
  const [purging, setPurging] = useState<TrashedVault | null>(null)
  const [purgePassword, setPurgePassword] = useState('')
  const onServer = !!status.vaultId && !!vaults?.some((v) => v.id === status.vaultId)
  const needsConfirm = status.reason === 'NEEDS_CONFIRM'
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const load = useCallback(async () => {
    try {
      const [i, v, tr] = await Promise.all([accountInfo(), cloudVaults(), cloudTrashed()])
      setInfo(i)
      setVaults(v)
      setTrashed(tr)
    } catch (e) {
      setMessage(syncError(e))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  // the list of held deletions is read again whenever the sync says it is waiting (its count can change between rounds)
  useEffect(() => {
    if (!needsConfirm) {
      setHeld([])
      return
    }
    syncHeld()
      .then(setHeld)
      .catch(() => setHeld([]))
  }, [needsConfirm, status.error])

  const run = async (job: () => Promise<void>, after?: () => void) => {
    setBusy(true)
    setMessage('')
    try {
      await job()
      after?.()
    } catch (e) {
      setMessage(syncError(e))
    } finally {
      setBusy(false)
    }
  }
  const download = (v: ServerVault) =>
    run(async () => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const parent = await open({ directory: true, title: t('Choose the folder to put “{name}” in').replace('{name}', v.name) })
      if (typeof parent !== 'string') return
      await cloudDownload(v.id, v.name, parent)
      window.location.reload() // the downloaded workspace is now the open one
    })
  const restore = (v: TrashedVault) =>
    run(
      async () => {
        await cloudRestore(v.id)
      },
      () => void load(),
    )
  const removeFromServer = (v: ServerVault) =>
    run(async () => {
      const syncStopped = await cloudDelete(v.id)
      setRemoving(null)
      await load()
      refresh()
      setMessage(
        syncStopped
          ? t('“{name}” is in the server trash. Sync is off for this workspace; the files on this computer are untouched.').replace('{name}', v.name)
          : t('“{name}” is in the server trash. You can restore it from there.').replace('{name}', v.name),
      )
    })
  const purgeFromServer = (v: TrashedVault) =>
    run(async () => {
      await cloudPurge(v.id, purgePassword)
      setPurging(null)
      setPurgePassword('')
      await load()
      setMessage(t('“{name}” was removed from the server for good.').replace('{name}', v.name))
    })
  const deleteAccount = () =>
    run(async () => {
      await accountDelete(deletePassword)
      setDeleting(false)
      setDeletePassword('')
      refresh()
    })
  const changePassword = () =>
    run(async () => {
      await accountChangePassword(oldPassword, newPassword)
      setOldPassword('')
      setNewPassword('')
      setMessage(t('The password was changed.'))
    })
  const newKey = () =>
    run(async () => {
      if (!oldPassword) throw new Error(t('Type your password first.'))
      onKey(await accountNewRecoveryKey(oldPassword), status.username ?? '')
    })

  return (
    <>
      <PreferenceGroup title={t('Account')}>
        <PreferenceRow label={status.username ?? ''} hint={status.server}>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await accountLogout()
                refresh()
              })
            }
          >
            {t('Sign out')}
          </Button>
        </PreferenceRow>
        {info?.quota && (
          <p className="prefs-note">{t('Storage used on the server: {used} of {limit}').replace('{used}', formatBytes(info.quota.used)).replace('{limit}', formatBytes(info.quota.limit))}</p>
        )}
      </PreferenceGroup>

      <PreferenceGroup title={t('This workspace')} hint={t('Turn it on and the workspace is copied to the server, then kept the same on every device you sign in on.')}>
        {!status.syncOn && (
          <Notice
            tone="info"
            title={onServer ? t('This workspace is already on your server') : t('This workspace is only on this computer')}
            action={
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await syncSet(true)
                    await load()
                    refresh()
                  })
                }
              >
                {onServer ? t('Keep it synced') : t('Send to your server and keep it synced')}
              </Button>
            }
          >
            {onServer
              ? t('Sync is off, so changes are not exchanged with the server. Turn it on to keep this workspace the same on all your devices.')
              : t('Send it once and it stays the same on every device you sign in on: changes go both ways, by themselves.')}
          </Notice>
        )}
        <PreferenceRow label={t('Sync this workspace')} hint={status.syncOn ? `${t('Kept in sync with the server')} · ${statusText(status)}` : statusText(status)}>
          <Switch
            label={t('Sync this workspace')}
            checked={status.syncOn}
            disabled={busy}
            onChange={(on) =>
              void run(async () => {
                await syncSet(on)
                refresh()
              })
            }
          />
        </PreferenceRow>
        {status.syncOn && (
          <PreferenceRow label={t('Sync now')}>
            <Button
              disabled={busy || status.state === 'syncing'}
              onClick={() =>
                void run(async () => {
                  await syncNow()
                  refresh()
                })
              }
            >
              {t('Sync now')}
            </Button>
          </PreferenceRow>
        )}
        {status.reason === 'NEEDS_CONFIRM' && (
          <Notice
            tone="warn"
            role="alert"
            title={t('Deletions are waiting')}
            action={
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await syncConfirm(held)
                    refresh()
                  })
                }
              >
                {t('Allow the deletions')}
              </Button>
            }
          >
            {t('Many files, or a whole side, would be deleted by this sync. They are kept aside for 30 days. Allow them only if that is what you meant.')}
            {held.length > 0 && (
              <ul dir="ltr" style={{ textAlign: 'left' }}>
                {held.slice(0, HELD_SHOWN).map((d) => (
                  <li key={d.path} style={{ wordBreak: 'break-all' }}>
                    {d.path}
                  </li>
                ))}
                {held.length > HELD_SHOWN && <li>{t('and {n} more').replace('{n}', String(held.length - HELD_SHOWN))}</li>}
              </ul>
            )}
          </Notice>
        )}
        {!!status.skippedPaths?.length && (
          <details className="prefs-note">
            <summary>{t('{n} files were skipped').replace('{n}', String(status.skippedPaths.length))}</summary>
            <p>{t('The names of these files cannot be synced (hidden characters or an unsupported name). They stay where they are. Rename them to sync them.')}</p>
            <ul dir="ltr" style={{ textAlign: 'left' }}>
              {status.skippedPaths.map((p) => (
                <li key={p} style={{ wordBreak: 'break-all' }}>
                  {JSON.stringify(p).slice(1, -1)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </PreferenceGroup>

      <PreferenceGroup title={t('Workspaces on the server')} hint={t('Bring one to this device. It opens here and stays in sync.')}>
        {vaults === null && <p className="prefs-note">{t('Loading…')}</p>}
        {vaults?.length === 0 && <p className="prefs-note">{t('Nothing is on the server yet. Turn on sync for a workspace to put it there.')}</p>}
        {vaults?.map((v) => (
          <PreferenceRow key={v.id} label={v.name} hint={`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`}>
            <Button disabled={busy} onClick={() => void download(v)}>
              {t('Download')}
            </Button>{' '}
            <Button disabled={busy} onClick={() => setRemoving(v)}>
              {t('Delete from server…')}
            </Button>
          </PreferenceRow>
        ))}
      </PreferenceGroup>

      {trashed.length > 0 && (
        <PreferenceGroup title={t('Workspaces in the server trash')} hint={t('They are removed from the server for good after a while. Restore one to get it back.')}>
          {trashed.map((v) => (
            <PreferenceRow key={v.id} label={v.name} hint={`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`}>
              <Button disabled={busy} onClick={() => void restore(v)}>
                {t('Restore')}
              </Button>{' '}
              <Button
                disabled={busy}
                onClick={() => {
                  setMessage('')
                  setPurging(v)
                }}
              >
                {t('Delete permanently…')}
              </Button>
            </PreferenceRow>
          ))}
        </PreferenceGroup>
      )}

      <PreferenceGroup title={t('Devices')}>
        {info?.devices?.map((d) => (
          <PreferenceRow key={d.id} label={d.name} hint={d.current ? t('This device') : undefined}>
            {!d.current && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    async () => {
                      await accountRevokeDevice(d.id)
                    },
                    () => void load(),
                  )
                }
              >
                {t('Remove')}
              </Button>
            )}
          </PreferenceRow>
        ))}
      </PreferenceGroup>

      <PreferenceGroup title={t('Password and recovery key')}>
        <PreferenceRow wide label={t('Current password')}>
          <Field ltr type="password" value={oldPassword} autoComplete="current-password" aria-label={t('Current password')} onChange={(e) => setOldPassword(e.target.value)} />
        </PreferenceRow>
        <PreferenceRow wide label={t('New password')}>
          <Field ltr type="password" value={newPassword} autoComplete="new-password" aria-label={t('New password')} onChange={(e) => setNewPassword(e.target.value)} />
        </PreferenceRow>
        <PreferenceRow wide label="">
          <Button disabled={busy || !oldPassword || !newPassword} onClick={() => void changePassword()}>
            {t('Change password')}
          </Button>{' '}
          <Button disabled={busy || !oldPassword} onClick={() => void newKey()}>
            {t('Make a new recovery key')}
          </Button>
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title={t('Delete account')} hint={t('Your account and its workspaces on the server are removed after 30 days. The workspaces on your devices stay.')}>
        <PreferenceRow label="">
          <Button disabled={busy} onClick={() => setDeleting(true)}>
            {t('Delete my account…')}
          </Button>
        </PreferenceRow>
      </PreferenceGroup>
      {deleting && (
        <Dialog
          open
          title={t('Delete your account?')}
          onClose={() => {
            setDeleting(false)
            setDeletePassword('')
          }}
          actions={
            <>
              <Button disabled={busy} onClick={() => setDeleting(false)}>
                {t('Cancel')}
              </Button>
              <Button variant="primary" disabled={busy || !deletePassword} onClick={() => void deleteAccount()}>
                {t('Delete my account')}
              </Button>
            </>
          }
        >
          <div className="ds-modal-body">
            <p>{t('Type your password to confirm. You are signed out here, and the server removes the account after 30 days.')}</p>
            <Field ltr type="password" value={deletePassword} autoComplete="current-password" aria-label={t('Password')} onChange={(e) => setDeletePassword(e.target.value)} />
            {message && (
              <Notice tone="bad" role="alert">
                {message}
              </Notice>
            )}
          </div>
        </Dialog>
      )}

      {removing && (
        <Dialog
          open
          title={t('Delete “{name}” from the server?').replace('{name}', removing.name)}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setRemoving(null)}>
                {t('Cancel')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void removeFromServer(removing)}>
                {t('Delete from server')}
              </Button>
            </>
          }
        >
          <div className="ds-modal-body">
            <p>{t('It moves to the server’s trash and can be restored for 30 days. The files on this computer stay.')}</p>
            {removing.id === status.vaultId && <p>{t('Sync for this workspace will be turned off.')}</p>}
            {message && (
              <Notice tone="bad" role="alert">
                {message}
              </Notice>
            )}
          </div>
        </Dialog>
      )}
      {purging && (
        <Dialog
          open
          title={t('Delete “{name}” permanently?').replace('{name}', purging.name)}
          onClose={() => {
            setPurging(null)
            setPurgePassword('')
          }}
          actions={
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  setPurging(null)
                  setPurgePassword('')
                }}
              >
                {t('Cancel')}
              </Button>
              <Button variant="primary" disabled={busy || !purgePassword} onClick={() => void purgeFromServer(purging)}>
                {t('Delete permanently')}
              </Button>
            </>
          }
        >
          <div className="ds-modal-body">
            <p>{t('This removes the workspace from the server for good. It cannot be undone. The files on your devices stay. Type your password to confirm.')}</p>
            <Field ltr type="password" value={purgePassword} autoComplete="current-password" aria-label={t('Password')} onChange={(e) => setPurgePassword(e.target.value)} />
            {message && (
              <Notice tone="bad" role="alert">
                {message}
              </Notice>
            )}
          </div>
        </Dialog>
      )}

      {message && !deleting && !removing && !purging && (
        <Notice tone="info" role="status">
          {message}
        </Notice>
      )}
    </>
  )
}

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [key, setKey] = useState<{ text: string; username: string } | null>(null)
  const refresh = useCallback(() => {
    accountStatus()
      .then(setStatus)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!isTauri) return
    refresh()
    // the app says when the status changes; the slow poll is only a safety net
    const timer = window.setInterval(refresh, 20000)
    let closed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('sync-status', refresh))
      .then((stop) => {
        if (closed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      closed = true
      unlisten?.()
      window.clearInterval(timer)
    }
  }, [refresh])

  if (!isTauri)
    return (
      <PreferenceGroup title={t('Sync')}>
        <p className="prefs-note">{t('Sync is available in the desktop app.')}</p>
      </PreferenceGroup>
    )
  if (!status) return <p role="status">{t('Loading…')}</p>
  const onKey = (text: string, username: string) => setKey({ text, username })
  return (
    <>
      {status.signedIn ? <SignedIn status={status} refresh={refresh} onKey={onKey} /> : <SignIn status={status} onDone={refresh} onKey={onKey} />}
      {key && <RecoveryKeyDialog keyText={key.text} username={key.username} onClose={() => setKey(null)} />}
    </>
  )
}
