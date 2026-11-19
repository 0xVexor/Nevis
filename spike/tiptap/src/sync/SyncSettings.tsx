// Settings → Sync: sign in to the person's own Nevis server, turn sync on for the open workspace, see what it is doing,
// bring a workspace from the server to this device, and manage devices. Desktop only. The engine decides what moves;
// this page only asks for things and tells what happened.
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, Field, Notice, PreferenceGroup, PreferenceRow } from '../design-system'
import { Switch } from '../design-system/controls'
import { isTauri, vaultList } from '../db'
import { t } from '../i18n'
import { PurgeDialog } from './PurgeDialog'
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
  passwordError,
  purgeError,
  saveRecoveryKeyFile,
  serverHealth,
  syncConfirm,
  syncError,
  syncHeld,
  syncNow,
  syncReupload,
  syncSet,
  type AccountInfo,
  type HeldDelete,
  type ServerHealth,
  type ServerVault,
  type SyncStatus,
  type TrashedVault,
} from './client'

const HELD_SHOWN = 10

/** Sync is working (or about to): the states in which "kept in sync with the server" is true. */
const isWorking = (s: SyncStatus) => s.syncOn && ['idle', 'syncing', 'pending'].includes(s.state)

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
      switch (s.reason) {
        case 'NEEDS_CONFIRM':
          return t('{n} deletions are waiting for your OK.').replace('{n}', s.error)
        case 'SIGNED_OUT':
          return t('You are signed out of the server. Sign in again.')
        case 'CLOUD_GONE':
          return t('This workspace is no longer on the server (it was deleted there). The files on this computer are untouched.')
        case 'VAULT_MISSING':
          return t('The vault folder was not found.')
        case 'VAULT_MISMATCH':
          return t('A different vault is in this folder.')
        default:
          return t('Sync is paused')
      }
    case 'error': {
      // never the raw code or the technical lines behind it
      const m = syncError(s.error)
      return /^(HUB|AUTH|NETWORK):|\n/.test(m) ? t('Sync failed') : m
    }
    default:
      return t('Sync is off for this workspace.')
  }
}

/** What marks a workspace on the server when names alone do not: that it is the open one, and a short piece of its id when another has the same name. */
function VaultTags({ id, openId, showId }: { id: string; openId?: string | null; showId: boolean }) {
  return (
    <>
      {id === openId && <span className="prefs-badge">{t('This workspace')}</span>}
      {showId && (
        <span dir="ltr" className="prefs-tag-id">
          {t('ID {id}').replace('{id}', id.slice(0, 6))}
        </span>
      )}
    </>
  )
}

/** The names that more than one workspace on the server has. */
function duplicateNames(list: { name: string }[]): Set<string> {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const v of list) (seen.has(v.name) ? twice : seen).add(v.name)
  return twice
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
        <div className="prefs-actions">
          <Button onClick={() => void saveFile()}>{t('Save to a file')}</Button>
          <Button onClick={() => void copy()}>{t('Copy')}</Button>
        </div>
        {note && <p role="status">{note}</p>}
      </div>
    </Dialog>
  )
}

function SignIn({ status, onDone, onKey }: { status: SyncStatus; onDone: () => void; onKey: (key: string, username: string) => void }) {
  // The server a release build is fixed to (empty in dev builds): then the address is not asked for, unless the person wants another server.
  const defaultServer = status.defaultServer
  const [server, setServer] = useState(status.server || '')
  const [customServer, setCustomServer] = useState(false)
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
  const showServerField = !defaultServer || customServer || (!!server.trim() && server.trim() !== defaultServer)
  const serverUsed = showServerField ? server : defaultServer
  const check = () =>
    run(async () => {
      setHealth(await serverHealth(serverUsed))
    })
  // with the address hidden there is no field to leave: ask the server what it takes (new accounts, invite code) right away
  useEffect(() => {
    if (!showServerField) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const signIn = () =>
    run(async () => {
      await accountLogin(serverUsed, username, password)
      onDone()
    })
  const register = () =>
    run(async () => {
      const key = await accountRegister(serverUsed, username, password, invite)
      onKey(key, username)
      onDone()
    })
  const recoverNow = () =>
    run(async () => {
      const key = await accountRecover(serverUsed, username, recoveryKey, password)
      onKey(key, username)
      onDone()
    })
  const registration = health?.registration
  return (
    <PreferenceGroup title={t('Your server')} hint={t('Sync keeps your workspaces the same on all your devices. Files are sent only to the server shown below, and only for workspaces with sync turned on.')}>
      <Notice tone="info" title={t('Sign in to send this workspace to your server')}>
        {t('This workspace is only on this computer. After you sign in, you can send it to your server and keep it synced.')}
      </Notice>
      {showServerField ? (
        <PreferenceRow wide label={t('Server address')} hint={t('For example sync.example.com')}>
          <Field ltr value={server} placeholder="sync.example.com" aria-label={t('Server address')} onChange={(e) => setServer(e.target.value)} onBlur={() => server.trim() && void check()} />
        </PreferenceRow>
      ) : (
        <p className="prefs-note">
          {t('Server:')} <bdi dir="ltr">{defaultServer.replace(/^https?:\/\//, '')}</bdi>{' '}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
              setCustomServer(true)
              setHealth(null)
            }}>
            {t('Use a different server')}
          </Button>
        </p>
      )}
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
            <Button variant="primary" disabled={busy || !serverUsed.trim() || !username || !password || !recoveryKey} onClick={() => void recoverNow()}>
              {t('Set the new password')}
            </Button>
            <Button disabled={busy} onClick={() => setRecover(false)}>
              {t('Back')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy || !serverUsed.trim() || !username || !password} onClick={() => void signIn()}>
              {t('Sign in')}
            </Button>
            {registration !== 'closed' && (
              <Button disabled={busy || !serverUsed.trim() || !username || !password} onClick={() => void register()}>
                {t('Create account')}
              </Button>
            )}
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
  // the workspaces that are on this computer (their folder is there): a server workspace among them is not downloaded again
  const [onComputer, setOnComputer] = useState<Set<string>>(new Set())
  const [trashed, setTrashed] = useState<TrashedVault[]>([])
  const [held, setHeld] = useState<HeldDelete[]>([])
  const [deleting, setDeleting] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [removing, setRemoving] = useState<ServerVault | null>(null)
  const [purging, setPurging] = useState<TrashedVault | null>(null)
  const onServer = !!status.vaultId && !!vaults?.some((v) => v.id === status.vaultId)
  // two workspaces with the same name look alike: the row of the open one is marked, and a piece of the id tells the others apart
  const sameName = duplicateNames(vaults ?? [])
  const sameNameTrashed = duplicateNames(trashed)
  const inTrash = !!status.vaultId && trashed.some((v) => v.id === status.vaultId)
  const needsConfirm = status.reason === 'NEEDS_CONFIRM'
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const load = useCallback(async () => {
    try {
      const [i, v, tr, local] = await Promise.all([accountInfo(), cloudVaults(), cloudTrashed(), vaultList().catch(() => null)])
      setInfo(i)
      setVaults(v)
      setTrashed(tr)
      setOnComputer(new Set((local?.vaults ?? []).filter((x) => x.exists).map((x) => x.id)))
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

  // `describe`: how an error is told; the dialogs that ask for the password say "the password is wrong" for a rejected one
  const run = async (job: () => Promise<void>, after?: () => void, describe: (e: unknown) => string = syncError) => {
    setBusy(true)
    setMessage('')
    try {
      await job()
      after?.()
    } catch (e) {
      setMessage(describe(e))
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
    run(
      async () => {
        const syncStopped = await cloudPurge(v.id)
        setPurging(null)
        await load()
        refresh()
        setMessage(
          syncStopped
            ? t('“{name}” was removed from the server for good. Sync is off for this workspace; the files on this computer are untouched.').replace('{name}', v.name)
            : t('“{name}” was removed from the server for good.').replace('{name}', v.name),
        )
      },
      undefined,
      purgeError,
    )
  const deleteAccount = () =>
    run(
      async () => {
        await accountDelete(deletePassword)
        setDeleting(false)
        setDeletePassword('')
        refresh()
      },
      undefined,
      passwordError,
    )
  const changePassword = () =>
    run(
      async () => {
        await accountChangePassword(oldPassword, newPassword)
        setOldPassword('')
        setNewPassword('')
        setMessage(t('The password was changed.'))
      },
      undefined,
      passwordError,
    )
  const newKey = () =>
    run(
      async () => {
        if (!oldPassword) throw new Error(t('Type your password first.'))
        onKey(await accountNewRecoveryKey(oldPassword), status.username ?? '')
      },
      undefined,
      passwordError,
    )

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
        <PreferenceRow label={t('Sync this workspace')} hint={isWorking(status) ? `${t('Kept in sync with the server')} · ${statusText(status)}` : statusText(status)}>
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
        {status.syncOn && status.reason === 'CLOUD_GONE' && (
          <Notice
            tone="warn"
            role="alert"
            title={t('This workspace is no longer on the server')}
            action={
              <div className="prefs-actions">
                {inTrash ? (
                  // the server keeps the id of a workspace in its trash and refuses to create it again: it has to come back from there
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await cloudRestore(status.vaultId ?? '')
                        await syncNow()
                        await load()
                        refresh()
                      })
                    }
                  >
                    {t('Restore from the server trash')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await syncReupload()
                        refresh()
                      })
                    }
                  >
                    {t('Send it to the server again')}
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await syncSet(false)
                      await load()
                      refresh()
                    })
                  }
                >
                  {t('Turn off sync')}
                </Button>
              </div>
            }
          >
            {t('This workspace is no longer on the server (it was deleted there). The files on this computer are untouched.')}
          </Notice>
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
          <PreferenceRow
            key={v.id}
            label={v.name}
            hint={
              <>
                {`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`} <VaultTags id={v.id} openId={status.vaultId} showId={sameName.has(v.name)} />
              </>
            }
          >
            <div className="prefs-actions">
              {v.id === status.vaultId || onComputer.has(v.id) ? (
                <span className="prefs-note">{v.id === status.vaultId ? t('Open now') : t('On this computer')}</span>
              ) : (
                <Button disabled={busy} onClick={() => void download(v)}>
                  {t('Download')}
                </Button>
              )}
              <Button variant="danger" disabled={busy} onClick={() => setRemoving(v)}>
                {t('Delete from server…')}
              </Button>
            </div>
          </PreferenceRow>
        ))}
      </PreferenceGroup>

      {trashed.length > 0 && (
        <PreferenceGroup title={t('Workspaces in the server trash')} hint={t('They are removed from the server for good after a while. Restore one to get it back.')}>
          {trashed.map((v) => (
            <PreferenceRow
              key={v.id}
              label={v.name}
              hint={
                <>
                  {`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`} <VaultTags id={v.id} openId={status.vaultId} showId={sameNameTrashed.has(v.name)} />
                </>
              }
            >
              <div className="prefs-actions">
                <Button disabled={busy} onClick={() => void restore(v)}>
                  {t('Restore')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setMessage('')
                    setPurging(v)
                  }}
                >
                  {t('Delete permanently…')}
                </Button>
              </div>
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
          </Button>
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
            <p>
              <b>{removing.name}</b> <VaultTags id={removing.id} openId={status.vaultId} showId={sameName.has(removing.name)} />
            </p>
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
        <PurgeDialog
          vault={purging}
          tags={<VaultTags id={purging.id} openId={status.vaultId} showId={sameNameTrashed.has(purging.name)} />}
          note={purging.id === status.vaultId && <p>{t('Sync for this workspace will be turned off.')}</p>}
          busy={busy}
          error={message}
          onCancel={() => setPurging(null)}
          onConfirm={() => void purgeFromServer(purging)}
        />
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
