import { DriveAccountDialog } from './DriveSync'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  isTauri, saveTextFile, accountChangePassword, accountDelete, accountInfo, accountLogin, accountLogout, accountNewRecoveryKey, accountRecover, accountRegister, accountRevokeDevice, accountStatus,
  cloudPurge, cloudReupload, cloudRestore, cloudTrashed, serverHealth, syncConfirm, syncNow, syncSet, vaultInfo,
  type AccountInfo, type AccountStatus, type ServerHealth, type TrashedVault,
} from './db'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { download } from './backup'
import { alertDialog, confirmDialog } from './dialog'
import { explain } from './vaultErrors'
import { ago } from './ui'
import * as Ic from './icons'
import { locale, t } from './i18n'
import { GitHubAccountDialog } from './GitHubSync'
import { version } from '../package.json'

// ───── small helpers ─────

/** The account status, kept current while the component is shown. */
export function useAccountStatus(every = 2000): [AccountStatus | null, () => Promise<void>] {
  const [st, setSt] = useState<AccountStatus | null>(null)
  const refresh = useCallback(() => accountStatus().then(setSt, () => {}), [])
  useEffect(() => {
    void refresh()
    const id = window.setInterval(refresh, every)
    return () => window.clearInterval(id)
  }, [refresh, every])
  return [st, refresh]
}

const when = (ts: number) => (ts ? new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('Not yet'))

export function size(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) (n /= 1024, i++)
  return `${n.toLocaleString(locale(), { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`
}

/** The words for what the sync of the open vault is doing. */
export function syncLabel(a: AccountStatus) {
  if (!a.signedIn) return t('Signed out')
  if (!a.syncOn) return t('Off for this workspace')
  return a.state === 'syncing' ? t('Syncing…') : a.state === 'offline' ? t('Offline') : a.state === 'error' ? t('Error') : a.state === 'paused' ? t('Paused') : t('Up to date')
}

const host = (server: string) => {
  try {
    return new URL(server).host
  } catch {
    return server
  }
}

/** 0 to 3: a rough idea of how hard a password is to guess; the server only insists on 8 characters. */
function strength(pw: string) {
  if (pw.length < 8) return 0
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  if (pw.length >= 16 || (pw.length >= 12 && classes >= 3)) return 3
  return pw.length >= 12 || classes >= 3 ? 2 : 1
}

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/i

// ───── form pieces ─────

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="acct-field">
      <span className="acct-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

function PasswordInput({ value, onChange, autoComplete, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <span className="acct-pw">
      <input dir="ltr" type={show ? 'text' : 'password'} value={value} autoComplete={autoComplete} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="icon-btn" tabIndex={-1} title={show ? t('Hide password') : t('Show password')} aria-label={show ? t('Hide password') : t('Show password')} onClick={() => setShow(!show)}>
        <Ic.Eye size={16} />
      </button>
    </span>
  )
}

function Meter({ pw }: { pw: string }) {
  const s = strength(pw)
  if (!pw) return null
  return (
    <span className={'acct-meter s' + s} aria-live="polite">
      <i /><i /><i />
      <small>{s === 0 ? t('Too short') : s === 1 ? t('Fair') : s === 2 ? t('Good') : t('Strong')}</small>
    </span>
  )
}

function Problem({ children, error }: { children: ReactNode; error?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [error])
  const details = error ? `Nevis ${version}\n${error}` : ''
  return <div className="acct-err" role="alert" dir="auto">
    <p>{children}</p>
    {details && <details className="acct-error-details"><summary><Ic.Chevron size={14} />{t('Error details')}</summary>
      <pre dir="ltr">{details}</pre>
      <div className="acct-row"><button type="button" onClick={() => { void navigator.clipboard.writeText(details).then(() => setCopied(true), () => setCopied(false)) }}>{copied ? <Ic.Check size={14} /> : <Ic.Copy size={14} />}{copied ? t('Copied') : t('Copy error details')}</button></div>
    </details>}
  </div>
}
const Note = ({ children }: { children: ReactNode }) => <p className="acct-note" dir="auto">{children}</p>

function Busy({ on, children }: { on: boolean; children: ReactNode }) {
  return <>{on && <i className="acct-spin" aria-hidden="true" />}{children}</>
}

/** The recovery key, shown once. It is the only way back in after a forgotten password, because there is no email to send a link to. */
export function KeyScreen({ keyText, username, onDone, doneLabel }: { keyText: string; username: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [filed, setFiled] = useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the key is on the screen; copying by hand works */
    }
  }
  const save = async () => {
    const name = `nevis-recovery-key-${username || 'account'}.txt`
    const text = `Nevis recovery key
User name: ${username}
Key: ${keyText}

Keep this somewhere safe. With it you can choose a new password if you forget yours.
`
    if (!isTauri) return download(name, new Blob([text], { type: 'text/plain' }))
    // the desktop webview cannot download a file: the system's save dialog, then the backend writes it
    try {
      const path = await saveDialog({ title: t('Save your recovery key'), defaultPath: name, filters: [{ name: 'Text', extensions: ['txt'] }] })
      if (!path) return
      await saveTextFile(path, text)
      setFiled(path)
    } catch (e) {
      setFiled('')
      void alertDialog({ title: t('The file was not saved'), message: explain(e) })
    }
  }

  return (
    <div className="acct-keyscreen">
      <div className="acct-hero">
        <span className="acct-hero-ic key"><Ic.Key size={22} /></span>
        <h3>{t('Save your recovery key')}</h3>
        <p>{t('If you forget your password, this key is the only way back into your account. Nevis never asks for an email address, so there is no link to send. It is shown only now.')}</p>
      </div>
      <div className="acct-key" dir="ltr" data-testid="recovery-key">{keyText}</div>
      <div className="acct-row">
        <button type="button" onClick={copy}><Ic.Copy size={15} />{copied ? t('Copied') : t('Copy')}</button>
        <button type="button" onClick={() => void save()}><Ic.Download size={15} />{t('Save as a file')}</button>
      </div>
      {filed && <p className="acct-meta" dir="auto">{t('Saved to {path}', { path: filed })}</p>}
      <label className="acct-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t('I have saved my recovery key somewhere safe.')}</span>
      </label>
      <button type="button" className="primary acct-wide" disabled={!saved} onClick={onDone}>{doneLabel ?? t('Continue')}</button>
    </div>
  )
}

// ───── sign in, create an account, recover ─────

type Mode = 'signin' | 'signup' | 'recover' | 'key'

/**
 * Everything a person does to get into an account: sign in, create one (user name and password, an invite code when the server wants one),
 * and recover with the recovery key. There is no email anywhere in it. `onDone` is called once they are signed in.
 */
export function AuthFlow({ status, initial = 'signin', onDone, onBack }: { status: AccountStatus | null; initial?: 'signin' | 'signup'; onDone: () => void; onBack?: () => void }) {
  const [mode, setMode] = useState<Mode>(initial)
  const [server, setServer] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [invite, setInvite] = useState('')
  const [recovery, setRecovery] = useState('')
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [reach, setReach] = useState<'checking' | 'ok' | 'down'>('checking')
  const [reachError, setReachError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const typedServer = useRef(false)

  useEffect(() => {
    if (status && !typedServer.current) setServer(status.server)
  }, [status])

  // the address in use: what was typed, else the one of the account, else the app's default
  const address = server.trim() || status?.server || status?.defaultServer || ''

  // ask the server about itself (does it take new accounts, does it want an invite code)
  const check = useCallback(() => {
    if (!address) return
    setReach('checking')
    let stale = false
    const timer = window.setTimeout(
      () =>
        serverHealth(address).then(
          (h) => !stale && (setHealth(h), setReach('ok')),
          (e) => !stale && (setHealth(null), setReachError(explain(e)), setReach('down')),
        ),
      typedServer.current ? 500 : 0,
    )
    return () => (stale = true, window.clearTimeout(timer))
  }, [address])
  useEffect(() => check(), [check])

  const closed = mode === 'signup' && health?.registration === 'closed'
  const needsInvite = mode === 'signup' && health?.registration === 'invite'
  const switchTo = (m: Mode) => {
    setMode(m)
    setError('')
    setPw('')
    setPw2('')
  }

  const problem = (): string => {
    if (!USERNAME.test(user.trim())) return explain('HUB:bad_username')
    if (mode === 'recover' && !recovery.trim()) return t('Type your recovery key.')
    if (mode !== 'signin' && pw.length < 8) return explain('HUB:weak_password')
    if (mode !== 'signin' && pw !== pw2) return t('The two passwords are not the same.')
    if (needsInvite && !invite.trim()) return t('This server needs an invite code.')
    if (mode === 'signin' && !pw) return t('Type your password.')
    return ''
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const bad = problem()
    if (bad) return setError(bad)
    setBusy(true)
    setError('')
    try {
      const name = user.trim()
      if (mode === 'signin') {
        await accountLogin(address, name, pw)
        onDone()
      } else if (mode === 'signup') {
        setKey(await accountRegister(address, name, pw, invite))
        setMode('key')
      } else {
        setKey(await accountRecover(address, name, recovery, pw))
        setMode('key')
      }
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'key') return <KeyScreen keyText={key} username={user.trim().toLowerCase()} onDone={onDone} />

  const title = mode === 'signin' ? t('Welcome back') : mode === 'signup' ? t('Create your account') : t('Reset your password')
  const sub =
    mode === 'signin'
      ? t('Sign in to get your notes on this device and keep them in sync.')
      : mode === 'signup'
        ? t('A user name and a password. No email address, no phone number.')
        : t('Type your recovery key and choose a new password. Your other devices will be signed out.')

  return (
    <form className="acct-form" onSubmit={submit} noValidate>
      {onBack && (
        <button type="button" className="acct-back" onClick={onBack}>
          <Ic.Arrow size={14} />{t('Back')}
        </button>
      )}
      <div className="acct-hero">
        <span className="acct-hero-ic"><Ic.Cloud size={22} /></span>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>

      {mode !== 'recover' && (
        <div className="segmented acct-seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'on' : ''} onClick={() => switchTo('signin')}>{t('Sign in')}</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchTo('signup')}>{t('Create account')}</button>
        </div>
      )}

      {closed && <Note>{t('This server is not taking new accounts.')}</Note>}

      <Field label={t('User name')} hint={mode === 'signup' ? t('3 to 32 letters, digits, dots, dashes or underscores.') : undefined}>
        <input dir="ltr" value={user} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus onChange={(e) => setUser(e.target.value)} />
      </Field>

      {mode === 'recover' && (
        <Field label={t('Recovery key')} hint={t('Looks like XXXXX-XXXXX-XXXXX-XXXXX. You saved it when you created the account.')}>
          <input dir="ltr" className="acct-mono" value={recovery} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" onChange={(e) => setRecovery(e.target.value.toUpperCase())} />
        </Field>
      )}

      <Field label={mode === 'recover' ? t('New password') : t('Password')}>
        <PasswordInput value={pw} onChange={setPw} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        {mode !== 'signin' && <Meter pw={pw} />}
      </Field>

      {mode !== 'signin' && (
        <Field label={t('Repeat the password')}>
          <PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" />
        </Field>
      )}

      {needsInvite && (
        <Field label={t('Invite code')} hint={t('Ask the person who runs your Nevis server.')}>
          <input dir="ltr" value={invite} autoComplete="off" spellCheck={false} onChange={(e) => setInvite(e.target.value)} />
        </Field>
      )}

      {error && <Problem>{error}</Problem>}

      <button type="submit" className="primary acct-wide" disabled={busy || closed}>
        <Busy on={busy}>{mode === 'signin' ? t('Sign in') : mode === 'signup' ? (busy ? t('Creating your account…') : t('Create account')) : t('Reset password')}</Busy>
      </button>

      <div className="acct-links">
        {mode === 'signin' && <button type="button" className="acct-link" onClick={() => switchTo('recover')}>{t('Forgot your password?')}</button>}
        {mode === 'recover' && <button type="button" className="acct-link" onClick={() => switchTo('signin')}>{t('Back to sign in')}</button>}
        <button type="button" className="acct-link" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t('Server')}</button>
      </div>

      {advanced && (
        <div className="acct-adv">
          <Field label={t('Server address')} hint={t('Only change this if you run your own Nevis server.')}>
            <input dir="ltr" value={server} spellCheck={false} placeholder={status?.defaultServer} onChange={(e) => ((typedServer.current = true), setServer(e.target.value))} />
          </Field>
          <span className={'acct-reach ' + reach}>
            <i />
            {reach === 'checking' ? t('Checking the server…') : reach === 'ok' ? t('Connected to {host}', { host: host(address) }) : reachError}
          </span>
          {status && server !== status.defaultServer && (
            <button type="button" className="acct-link" onClick={() => ((typedServer.current = false), setServer(status.defaultServer))}>{t('Use the default server')}</button>
          )}
        </div>
      )}
      {!advanced && reach === 'down' && <Problem>{reachError}</Problem>}
    </form>
  )
}

// ───── the account page (signed in) ─────

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="acct-card">
      <header>
        <h4>{title}</h4>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** A small form that asks for the password again before something that matters. */
function PasswordAsk({ label, action, danger, extra, onSubmit, onCancel }: { label: string; action: string; danger?: boolean; extra?: ReactNode; onSubmit: (pw: string) => Promise<void>; onCancel: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (e: FormEvent) => {
    e.preventDefault()
    if (!pw) return setError(t('Type your password.'))
    setBusy(true)
    setError('')
    try {
      await onSubmit(pw)
    } catch (err) {
      setError(explain(err))
      setBusy(false)
    }
  }
  return (
    <form className="acct-inline" onSubmit={go}>
      {extra}
      <Field label={label}>
        <PasswordInput value={pw} onChange={setPw} autoComplete="current-password" autoFocus />
      </Field>
      {error && <Problem>{error}</Problem>}
      <div className="acct-row">
        <button type="submit" className={'primary' + (danger ? ' danger' : '')} disabled={busy}><Busy on={busy}>{action}</Busy></button>
        <button type="button" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
      </div>
    </form>
  )
}

type Panel = '' | 'password' | 'key' | 'delete'

/**
 * The user's page: who is signed in, what the sync is doing, storage, devices, security. Signed out, it is the sign-in form instead.
 * Opened from the sync button, the workspaces dialog, the settings and the command palette.
 */
function LegacyAccountDialog({ onClose, onWorkspaces, startWith = 'signin' }: { onClose: () => void; onWorkspaces?: () => void; startWith?: 'signin' | 'signup' }) {
  const [acc, refreshAcc] = useAccountStatus()
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [infoError, setInfoError] = useState('')
  const [trashed, setTrashed] = useState<TrashedVault[]>([])
  const [trashedError, setTrashedError] = useState('')
  const [panel, setPanel] = useState<Panel>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [reauth, setReauth] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')

  const signedIn = !!acc?.signedIn && acc.provider === 'legacy'
  const load = useCallback(() => {
    if (!signedIn) return
    accountInfo().then(
      (i) => (setInfo(i), setInfoError('')),
      (e) => setInfoError(String(e)),
    )
    cloudTrashed().then((v) => { setTrashed(v); setTrashedError('') }, (e) => setTrashedError(String(e)))
  }, [signedIn])
  useEffect(() => load(), [load])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      await f()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      void refreshAcc()
      load()
    }
  }

  const signOut = async () => {
    const ok = await confirmDialog({
      title: t('Sign out of this device?'),
      message: t('Your notes stay on this computer. Sync stops until you sign in again.'),
      confirmLabel: t('Sign out'),
    })
    if (!ok) return
    await run(accountLogout)
    onClose()
  }

  const purge = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: t('Delete “{name}” for good?', { name }),
      message: t('It and all its files are removed from the server now and cannot be brought back. The notes on your devices are not touched.'),
      confirmLabel: t('Delete for good'),
      danger: true,
    })
    if (ok) await run(() => cloudPurge(id))
  }

  const revoke = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: t('Sign out “{name}”?', { name }),
      message: t('That device stops syncing until someone signs in on it again. Its notes stay on it.'),
      confirmLabel: t('Sign it out'),
      danger: true,
    })
    if (ok) await run(() => accountRevokeDevice(id))
  }

  const changePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (pw.length < 8) return setError(explain('HUB:weak_password'))
    if (pw !== pw2) return setError(t('The two passwords are not the same.'))
    await run(async () => {
      await accountChangePassword(oldPw, pw)
      setPanel('')
      setOldPw('')
      setPw('')
      setPw2('')
      setNote(t('Password changed. Your other devices were signed out.'))
    })
  }

  const sync = acc && acc.signedIn ? acc : null
  const paused = sync?.syncOn && sync.state === 'paused' ? sync.reason : ''
  const quotaPct = info ? Math.min(100, (info.quota.used / Math.max(1, info.quota.limit)) * 100) : 0
  const dot = !sync?.syncOn ? 'off' : sync.state

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wsd acct" role="dialog" aria-modal="true" aria-label={t('Account')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wsd-head">
          <b>{signedIn ? t('Account') : t('Account and sync')}</b>
          <button className="icon-btn" title={t('Close  Esc')} onClick={onClose}><Ic.Close size={16} /></button>
        </div>

        <div className="wsd-body">
          {acc === null ? (
            <p className="wsd-note">{t('Loading…')}</p>
          ) : !signedIn || reauth ? (
            <AuthFlow status={acc} initial={startWith} onDone={() => (setReauth(false), void refreshAcc())} onBack={reauth ? () => setReauth(false) : undefined} />
          ) : newKey ? (
            <KeyScreen keyText={newKey} username={acc.username ?? ''} onDone={() => (setNewKey(''), setNote(t('Your new recovery key is the only one that works now.')))} />
          ) : (
            <>
              <div className="acct-profile">
                <span className="acct-avatar" aria-hidden="true">{(acc.username ?? '?').slice(0, 1).toUpperCase()}</span>
                <div>
                  <b dir="ltr">{acc.username}</b>
                  <small dir="ltr">{host(acc.server)}</small>
                </div>
                <span className={'acct-pill ' + dot}><i />{syncLabel(acc)}</span>
              </div>

              {note && <Note>{note}</Note>}
              {error && <Problem error={error}>{explain(error)}</Problem>}

              <Section title={t('Sync')}>
                <dl className="wsd-info">
                  <dt>{t('This workspace')}</dt>
                  <dd><i className={'wsd-dot ' + dot} />{syncLabel(acc)}</dd>
                  <dt>{t('Last sync')}</dt>
                  <dd>{when(acc.lastAt)}</dd>
                </dl>
                {acc.syncOn && acc.state === 'offline' && <Note>{t('You are offline. Everything you write is saved on this device and goes to the server by itself when the connection is back.')}</Note>}
                {acc.syncOn && acc.state === 'error' && acc.error && <Problem error={acc.error}>{explain(acc.error)}</Problem>}
                {paused === 'SIGNED_OUT' && <Problem>{t('You are signed out of this device. Sign in again to keep syncing.')}</Problem>}
                {paused === 'VAULT_MISSING' && <Problem>{t('The vault folder was not found. Sync is paused and nothing in the cloud was changed. Use “Locate folder…” in the list above.')}</Problem>}
                {paused === 'VAULT_MISMATCH' && <Problem>{t('A different vault is in the folder of this workspace. Sync is paused and nothing was changed.')}</Problem>}
                {paused === 'CLOUD_GONE' && <Problem>{t('The cloud copy of this vault is gone (deleted from another device or from the server). Your files here are untouched.')}</Problem>}
                {paused === 'NEEDS_CONFIRM' && <Problem>{t('{n} files would be deleted by this sync. If you deleted them on purpose, confirm; otherwise turn sync off and check the folder.', { n: acc.error })}</Problem>}
                <div className="wsd-acts">
                  {paused === 'NEEDS_CONFIRM' && <button className="primary" disabled={busy} onClick={() => void run(syncConfirm)}>{t('Yes, delete them')}</button>}
                  {paused === 'SIGNED_OUT' && <button className="primary" disabled={busy} onClick={() => setReauth(true)}>{t('Sign in again')}</button>}
                  {paused === 'CLOUD_GONE' && <button className="primary" disabled={busy} onClick={() => void run(async () => cloudReupload((await vaultInfo()).id))}>{t('Upload this vault again')}</button>}
                  {acc.syncOn ? (
                    <>
                      <button disabled={busy} onClick={() => void run(syncNow)}><Ic.Cloud size={15} />{t('Sync now')}</button>
                      <button disabled={busy} onClick={() => void run(() => syncSet(false))}>{t('Turn off sync for this workspace')}</button>
                    </>
                  ) : (
                    <button className="primary" disabled={busy} onClick={() => void run(() => syncSet(true))}>{t('Turn on sync for this workspace')}</button>
                  )}
                  {onWorkspaces && <button onClick={() => (onClose(), onWorkspaces())}><Ic.Layers size={15} />{t('Workspaces…')}</button>}
                </div>
              </Section>

              <Section title={t('Storage')}>
                {info ? (
                  <>
                    <div className="acct-usage" role="progressbar" aria-valuenow={Math.round(quotaPct)} aria-valuemin={0} aria-valuemax={100}>
                      <i style={{ inlineSize: `${quotaPct}%` }} className={quotaPct > 90 ? 'full' : ''} />
                    </div>
                    <p className="acct-meta">{t('{used} of {limit} used · {n} vaults', { used: size(info.quota.used), limit: size(info.quota.limit), n: info.vaults })}</p>
                  </>
                ) : !infoError && <p className="acct-meta">{t('Loading…')}</p>}
                {infoError && <Problem error={infoError}>{explain(infoError)}</Problem>}
                {trashedError && <Problem error={trashedError}>{explain(trashedError)}</Problem>}
                {trashed.length > 0 && (
                  <div className="acct-trashed">
                    <h5>{t('Deleted from your account (kept for 30 days)')}</h5>
                    {trashed.map((v) => (
                      <div key={v.id} className="wsd-row">
                        <span className="wsd-ic"><Ic.Trash size={16} /></span>
                        <span className="wsd-tx"><b dir="auto">{v.name}</b><small>{ago(v.deletedAt)}</small></span>
                        <span className="wsd-acts">
                          <button disabled={busy} onClick={() => void run(() => cloudRestore(v.id))}>{t('Restore')}</button>
                          <button className="danger" disabled={busy} onClick={() => void purge(v.id, v.name)}>{t('Delete for good')}</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title={t('Devices')} aside={<small className="acct-meta">{t('Signed in on these devices')}</small>}>
                <div className="wsd-list">
                  {(info?.devices ?? []).map((d) => (
                    <div key={d.id} className={'wsd-row' + (d.current ? ' cur' : '')}>
                      <span className="wsd-ic"><Ic.Panel size={16} /></span>
                      <span className="wsd-tx">
                        <b dir="auto">{d.name}</b>
                        <small>{d.current ? t('This device') : t('Last active {when}', { when: ago(d.last_seen) })}</small>
                      </span>
                      {!d.current && <span className="wsd-acts"><button className="danger" disabled={busy} onClick={() => void revoke(d.id, d.name)}>{t('Sign out')}</button></span>}
                    </div>
                  ))}
                  {!info && !infoError && <p className="acct-meta">{t('Loading…')}</p>}
                </div>
              </Section>

              <Section title={t('Security')}>
                {panel === 'password' ? (
                  <form className="acct-inline" onSubmit={changePassword}>
                    <Field label={t('Current password')}><PasswordInput value={oldPw} onChange={setOldPw} autoComplete="current-password" autoFocus /></Field>
                    <Field label={t('New password')}><PasswordInput value={pw} onChange={setPw} autoComplete="new-password" /><Meter pw={pw} /></Field>
                    <Field label={t('Repeat the new password')}><PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" /></Field>
                    <div className="acct-row">
                      <button type="submit" className="primary" disabled={busy}><Busy on={busy}>{t('Change password')}</Busy></button>
                      <button type="button" onClick={() => setPanel('')} disabled={busy}>{t('Cancel')}</button>
                    </div>
                  </form>
                ) : panel === 'key' ? (
                  <PasswordAsk
                    label={t('Your password')}
                    action={t('Create a new key')}
                    extra={<Note>{t('A new recovery key replaces the old one: the old key stops working.')}</Note>}
                    onCancel={() => setPanel('')}
                    onSubmit={async (p) => {
                      setNewKey(await accountNewRecoveryKey(p))
                      setPanel('')
                    }}
                  />
                ) : panel === 'delete' ? (
                  <PasswordAsk
                    label={t('Your password')}
                    action={t('Delete my account')}
                    danger
                    extra={<Note>{t('The account and every vault on the server are deleted after 30 days. Until then, signing in again cancels the deletion. The notes on your devices are not touched.')}</Note>}
                    onCancel={() => setPanel('')}
                    onSubmit={async (p) => {
                      await accountDelete(p)
                      onClose()
                    }}
                  />
                ) : (
                  <div className="acct-lines">
                    <div className="acct-line">
                      <span>{t('Password')}</span>
                      <button disabled={busy} onClick={() => setPanel('password')}>{t('Change password…')}</button>
                    </div>
                    <div className="acct-line">
                      <span>{t('Recovery key')}</span>
                      <button disabled={busy} onClick={() => setPanel('key')}>{t('New recovery key…')}</button>
                    </div>
                    <div className="acct-line">
                      <span>{t('This device')}</span>
                      <button disabled={busy} onClick={() => void signOut()}>{t('Sign out')}</button>
                    </div>
                    <div className="acct-line danger">
                      <span>{t('Delete account…').replace('…', '')}</span>
                      <button className="danger" disabled={busy} onClick={() => setPanel('delete')}>{t('Delete account…')}</button>
                    </div>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function AccountDialog(props: { onClose: () => void; onWorkspaces?: () => void; startWith?: 'signin' | 'signup' }) {
  const [legacy, setLegacy] = useState(false)
  const [drive, setDrive] = useState(true)
  if (drive) return <DriveAccountDialog onClose={props.onClose} onGitHub={() => setDrive(false)} />
  return legacy ? <LegacyAccountDialog {...props} /> : <GitHubAccountDialog onClose={props.onClose} onLegacy={() => setLegacy(true)} />
}
