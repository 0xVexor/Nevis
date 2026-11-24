import { importNotes, prepareImport } from './markdownImport'
import type { ReactNode } from 'react'
import { t } from './i18n'
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { uuidv7 } from '@nevis/protocol'
import { AuthError, createWorkspace, deviceLabel, me, recoverAccount, signIn, signOut, signUp, workspaces, type Me, type WorkspaceInfo } from './auth'
import { Lab, type Note, type Status } from './lab'
import { appInfo, getDesktopPreference, isDesktop, onWindowFlush, setDesktopPreference, setServer } from './desktop'
import { installTranslator } from './i18n'
import { apply as applyDeviceSettings, restoreDesktopSettings, useSettings } from './deviceSettings'
import { Workspace } from './workspace'
import { WorkspaceView } from './WorkspaceView'
import { Brand } from './shell/Brand'
import { BrandMark } from './shell/BrandMark'
import { Button, Icon } from './ds'
import 'katex/dist/katex.min.css'
import '@nevis/editor/editor.css'
import './app.css'
import './ds/commands.css'
import './style.css'

installTranslator()
applyDeviceSettings()

declare global { interface Window { __lab?: Lab; __labReady?: Promise<void> } }

function startLab(ws: string, token: string | null): Lab {
  const lab = new Lab(ws, token)
  window.__lab = lab
  // started once, outside React (StrictMode runs effects twice in development, which would create two coordinators)
  window.__labReady = lab.start()
  return lab
}

function LabView({ lab, started, onSignOut }: { lab: Lab; started: Promise<void>; onSignOut?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    const refresh = async () => { const [s, n] = await Promise.all([lab.status(), lab.notes()]); if (live) { setStatus(s); setNotes(n) } }
    void started.then(() => { setReady(true); void refresh() })
    const off = lab.subscribe(() => void refresh())
    const t = setInterval(() => void refresh(), 1000)
    return () => { live = false; off(); clearInterval(t) }
  }, [])
  if (!ready || !status) return <main><p>{t('Opening…')}</p></main>
  const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`)
  return (
    <main dir="rtl">
      <h1>M3 — آزمایشگاه ذخیره‌سازی</h1>
      {onSignOut && <button data-testid="signout" onClick={onSignOut}>{t('Sign out')}</button>}
      <div className="bar" data-testid="status">
        <span data-testid="leader" data-leader={status.leader}>{status.leader ? '★ این تب leader است' : 'این تب leader نیست'}</span>
        <span>outbox: <b data-testid="outbox">{status.outbox}</b></span>
        <span>inbox: {status.inbox}</span>
        <span>cursor: <b data-testid="cursor">{status.cursor}</b></span>
        <span>persisted(): <b data-testid="persisted">{String(status.persisted)}</b></span>
        <span>estimate(): {mb(status.usage)} از {mb(status.quota)}</span>
        <span>یادداشت‌ها: <b data-testid="count">{status.notes}</b></span>
        <span>دورهای سینک: {status.rounds}</span>
        {status.lastError && <span className="err">خطا: {status.lastError}</span>}
      </div>
      <div className="row">
        <button onClick={() => void lab.newNote()}>یادداشت تازه</button>
        <button onClick={() => void lab.createNotes(100)}>۱۰۰ یادداشت</button>
        <button onClick={() => void lab.plusOneAll()}>+۱ همه</button>
        <button onClick={() => void lab.burst(5)}>۵ دور نوشتن پشت سر هم</button>
        <button onClick={() => void lab.fillJunk(100)}>پرکردن ۱۰۰MB</button>
        <label><input type="checkbox" checked={status.offline} onChange={e => { lab.offline = e.target.checked }} /> قطع شبکه (شبیه‌سازی)</label>
      </div>
      <ul data-testid="notes">
        {notes.slice(0, 40).map(n => (
          <li key={n.id}>
            <span data-testid="title">{n.title}</span> <b>{n.count}</b>
            <button onClick={() => { const t = prompt('عنوان تازه', n.title); if (t) void lab.editTitle(n.id, t) }}>ویرایش عنوان</button>
          </li>
        ))}
      </ul>
      {notes.length > 40 && <p>… و {notes.length - 40} یادداشت دیگر</p>}
      <p className="small">workspace <code>{status.ws}</code> · دستگاه <code>{status.device.slice(0, 8)}</code></p>
    </main>
  )
}


const errText = (e: unknown): string => {
  if (e instanceof AuthError) {
    const m: Record<string, string> = { bad_credentials: t('The username or password is not right'), rate_limited: t('Too many tries; try again in a moment'), username_taken: t('This username is taken'), registration_closed: t('This server does not accept new accounts'), bad_invite: t('The invite code is incorrect'), weak_password: t('Password needs at least eight characters'), bad_recovery_key: t('The recovery key is incorrect') }
    return m[e.code] ?? e.message
  }
  return t('The server is not reachable')
}

function SignInForm({ onDone, onServer }: { onDone: (recoveryKey?: string) => Promise<void>; onServer?: () => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'recover'>('in')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    const f = new FormData(ev.currentTarget)
    const u = String(f.get('username') ?? '').trim(), p = String(f.get('password') ?? ''), inv = String(f.get('invite') ?? '')
    setBusy(true); setErr('')
    try {
      if (mode === 'in') { await signIn(u, p, deviceLabel()); await onDone() }
      else {
        const r = mode === 'recover'
          ? await recoverAccount(u, String(f.get('recoveryKey') ?? ''), p, deviceLabel())
          : await signUp(u, p, deviceLabel(), inv)
        await onDone(r.recoveryKey)
      }
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Frame surface="auth">
      <h1>{mode === 'recover' ? t('Recover account') : mode === 'in' ? t('Sign in') : t('Create account')}</h1>
      <p>{mode === 'recover' ? t('Enter your recovery key and choose a new password.') : mode === 'in' ? t('Sign in so your notes sync.') : t('Create an account to sync your notes.')}</p>
      <form onSubmit={e => void submit(e)} data-testid="auth-form" className="onb-form">
        <label className="onb-field"><span>{t('Username')}</span><input className="ds-field" name="username" autoComplete="username" required dir="ltr" /></label>
        {mode === 'recover' && <label className="onb-field"><span>{t('Recovery key')}</span><input className="ds-field" name="recoveryKey" required dir="ltr" autoComplete="off" /></label>}
        <label className="onb-field"><span>{t(mode === 'recover' ? 'New password' : 'Password')}</span><input key={mode} className="ds-field" name="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required dir="ltr" /></label>
        {mode === 'up' && <label className="onb-field"><span>{t('Invite code (if needed)')}</span><input className="ds-field" name="invite" dir="ltr" /></label>}
        {err && <p className="err" role="alert" data-testid="auth-error">{err}</p>}
        <div className="onb-actions">
          <Button type="button" variant="ghost" disabled={busy} data-testid="auth-switch" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr('') }}>{mode === 'in' ? t('I have no account') : t('I have an account')}</Button>
          <Button type="submit" variant="primary" disabled={busy} data-testid="auth-submit">{mode === 'recover' ? t('Reset password') : mode === 'in' ? t('Sign in') : t('Create account')}</Button>
        </div>
        {busy && <Pending />}
      </form>
      {mode === 'in' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setErr(''); setMode('recover') }}>{t('Forgot your password?')}</Button>}
      {onServer && <Button variant="ghost" size="sm" disabled={busy} icon={<Icon name="settings" size={16} />} data-testid="custom-server" onClick={onServer}>{t('Server address')}</Button>}
    </Frame>
  )
}

function Pending() {
  return <div className="onb-pending" role="status"><span className="ds-command-state-icon" data-pending><BrandMark size={24} /></span><span>{t('Opening…')}</span></div>
}

/** The old app's first-run frame (`onb`): the brand at the top, one centered panel. */
function Frame({ children, wide, surface }: { children: ReactNode; wide?: boolean; surface?: "auth" | "workspaces" }) {
  return (
    <div className="onb" data-surface={surface}>
      <header className="onb-top"><span className="onb-brand"><BrandMark size={20} /><Brand /></span><span className="onb-top-end" /></header>
      <main className="onb-stage"><section className={'onb-panel' + (wide ? ' onb-panel--wide' : '')}>{children}</section></main>
    </div>
  )
}

/** Signed in: pick (or create) a workspace, then open it. */
function Home({ who, recoveryKey, onSignedOut }: { who: Me; recoveryKey?: string; onSignedOut: () => void }) {
  const [list, setList] = useState<WorkspaceInfo[] | null>(null)
  const [open, setOpen] = useState<{ ws: Workspace } | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'error'>('idle')
  const copyRecovery = async () => {
    if (!recoveryKey) return
    try { await navigator.clipboard.writeText(recoveryKey); setCopyState('done') }
    catch { setCopyState('error') }
  }
  const [busy, setBusy] = useState(false)
  const [checkingLast, setCheckingLast] = useState(true)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const lastKey = 'nevis.lastWorkspace.' + who.account.id
  const flushOff = useRef<(() => void) | undefined>(undefined)
  const remember = useCallback(async (id: string) => {
    try { localStorage.setItem(lastKey, id) } catch { /* private window */ }
    if (isDesktop) await setDesktopPreference(lastKey, id).catch(error => console.warn('Could not remember the last workspace', error))
  }, [lastKey])
  const leave = async () => { flushOff.current?.(); await open?.ws.stop(); await signOut().catch(() => undefined); onSignedOut() }
  const enter = useCallback(async (id: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    const ws = new Workspace(id, null)
    try {
      await ws.start()
      ;(window as unknown as { __ws?: Workspace }).__ws = ws
      if (isDesktop) {
        flushOff.current?.()
        flushOff.current = await onWindowFlush(async () => {
          await ws.flushAll()
          await Promise.race([ws.rt.engine.cycle().catch(() => undefined), new Promise(r => setTimeout(r, 4000))])
        })
      }
      await remember(id)
      setOpen({ ws })
    } catch (error) {
      await ws.stop().catch(() => undefined)
      setError(errText(error))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }, [remember])
  useEffect(() => {
    let alive = true
    void workspaces().then(async list => {
      if (!alive) return
      setList(list)
      if (recoveryKey) { setCheckingLast(false); return }
      let last: string | null
      try { last = localStorage.getItem(lastKey) } catch { last = null }
      if (isDesktop) {
        const native = await getDesktopPreference(lastKey).catch(error => { console.warn('Could not read the last workspace', error); return undefined })
        last = native ?? last
      }
      if (alive && last && list.some(workspace => workspace.id === last)) await enter(last)
      if (alive) setCheckingLast(false)
    }, error => { if (alive) { setError(errText(error)); setList([]); setCheckingLast(false) } })
    return () => { alive = false }
  }, [enter, lastKey, recoveryKey])
  const make = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const id = uuidv7()
      const name = t('Notes')
      await createWorkspace(id, name)
      setList(current => [...(current ?? []), { id, name, role: 'owner', head: 0 }])
      pending.current = false
      await enter(id)
    } catch (error) { setError(errText(error)) }
    finally { pending.current = false; setBusy(false) }
  }
  /** Imported data always goes into a new workspace. */
  const importFile = async (file: File) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const prepared = await prepareImport(file)
      const id = uuidv7()
      const name = file.name.replace(/\.nevis\.zip$|\.(zip|md|markdown|txt)$/i, '') || t('Import')
      await createWorkspace(id, name)
      setList(current => [...(current ?? []), { id, name, role: 'owner', head: 0 }])
      const ws = new Workspace(id, null)
      try {
        await ws.start()
        if (prepared.kind === 'bundle') await ws.importBundle(prepared.bytes)
        else await importNotes(ws, prepared.notes, prepared.files)
        if (isDesktop) {
          flushOff.current?.()
          flushOff.current = await onWindowFlush(async () => {
            await ws.flushAll()
            await Promise.race([ws.rt.engine.cycle().catch(() => undefined), new Promise(r => setTimeout(r, 4000))])
          })
        }
      } catch (error) { await ws.stop().catch(() => undefined); throw error }
      ;(window as unknown as { __ws?: Workspace }).__ws = ws
      await remember(id)
      setOpen({ ws })
    } catch (error) { setError(t('Import failed') + ' — ' + (error instanceof AuthError ? errText(error) : String((error as Error).message ?? error))) }
    finally { pending.current = false; setBusy(false) }
  }
  const back = async () => { flushOff.current?.(); await open?.ws.stop(); setOpen(null); void workspaces().then(setList, error => setError(errText(error))) }
  if (open) return <WorkspaceView ws={open.ws} onSignOut={() => void leave()} onWorkspaces={() => void back()} workspaceName={list?.find(w => w.id === open.ws.ws)?.name} />
  return (
    <Frame wide surface="workspaces">
      <h1>{t('Choose a workspace')}</h1>
      <p>{t('Open a workspace or create one.')}</p>
      {recoveryKey && <div className="recovery onb-key" data-testid="recovery"><p>{t('Save your recovery key before leaving this screen.')}</p><code dir="ltr">{recoveryKey}</code> <Button size="sm" onClick={() => void copyRecovery()}>{t(copyState === 'done' ? 'Copied' : 'Copy recovery key')}</Button>{copyState === 'error' && <p role="status">{t('Could not copy the key. Select and copy it manually.')}</p>}</div>}
      {error && <p role="alert" className="err">{error}</p>}
      {(checkingLast || list === null || busy) && <Pending />}
      {!checkingLast && list !== null && (
        <ul data-testid="ws-list" className="onb-list">{list.map(w => <li key={w.id}>
          <Icon name="vault" size={20} />
          <div className="onb-list-text"><b dir="auto">{w.name}</b><small>{t(w.role === 'owner' ? 'Owner' : w.role)}</small></div>
          <Button size="sm" disabled={busy} onClick={() => void enter(w.id)} aria-label={w.name}>{t('Open')}</Button>
        </li>)}</ul>
      )}
      <div className="onb-actions">
        <Button variant="primary" data-testid="ws-new" disabled={busy || checkingLast} onClick={() => void make()}>{t('New workspace')}</Button>
        <label className="ds-btn ds-btn--ghost">{t('Import notes')} <input type="file" accept=".zip,.md,.markdown,.txt" data-testid="ws-import" disabled={busy || checkingLast} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f) }} /></label>
        <Button variant="ghost" data-testid="signout" disabled={busy || checkingLast} onClick={() => void leave()}>{t('Sign out')}</Button>
      </div>
    </Frame>
  )
}

/** Desktop only: which server this app talks to (the one address JavaScript may name; Rust checks it). */
function ServerForm({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [err, setErr] = useState('')
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    try { await setServer(String(new FormData(ev.currentTarget).get('server') ?? '')); onDone() } catch (e) { setErr(String(e)) }
  }
  return (
    <Frame surface="auth">
      <h1>{t('Server address')}</h1>
      <p>{t('Nevis syncs with your own server; enter its address.')}</p>
      <form onSubmit={e => void submit(e)} data-testid="server-form" className="onb-form">
        <label className="onb-field"><span>{t('Your server address')}</span><input className="ds-field" name="server" dir="ltr" placeholder="https://notes.example.com" required /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="onb-actions"><Button type="button" variant="ghost" onClick={onBack}>{t('Cancel')}</Button><Button type="submit" variant="primary">{t('Continue')}</Button></div>
      </form>
    </Frame>
  )
}

function Root() {
  useSettings()
  const [state, setState] = useState<'loading' | 'server' | 'out' | 'unreachable' | { me: Me; recoveryKey?: string }>('loading')
  const refreshing = useRef(false)
  const pendingRecovery = useRef<string | undefined>(undefined)
  const refresh = useCallback(async (recoveryKey?: string) => {
    if (recoveryKey) pendingRecovery.current = recoveryKey
    if (refreshing.current) return
    refreshing.current = true
    try {
      if (isDesktop) {
        const info = await appInfo()
        if (!info.server || !info.hasToken) { setState('out'); return }
      }
      const account = await me()
      setState(account ? { me: account, recoveryKey: pendingRecovery.current } : 'out')
      pendingRecovery.current = undefined
    } catch {
      setState('unreachable')
    } finally { refreshing.current = false }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (state !== 'unreachable') return
    const retry = () => { if (navigator.onLine && !document.hidden) void refresh() }
    const timer = window.setInterval(retry, 15_000)
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
    }
  }, [state, refresh])
  // the start animation (index.html) fades away once the app has something to show
  useEffect(() => { if (state !== 'loading') (window as unknown as { __splashDone?: () => void }).__splashDone?.() }, [state])
  if (state === 'loading') return <Frame><Pending /></Frame>
  if (state === 'server') return <ServerForm onDone={() => void refresh()} onBack={() => void refresh()} />
  if (state === 'out') return <SignInForm onDone={refresh} onServer={isDesktop ? () => setState('server') : undefined} />
  if (state === 'unreachable') return <Frame surface="auth"><h1>{t('The server is not reachable')}</h1><div className="onb-actions">{isDesktop && <Button variant="ghost" onClick={() => setState('server')}>{t('Server address')}</Button>}<Button variant="primary" onClick={() => void refresh()}>{t('Try again')}</Button></div></Frame>
  return <Home who={state.me} recoveryKey={state.recoveryKey} onSignedOut={() => setState('out')} />
}

// Tests and the old lab: `?ws=<id>` opens that workspace at once with the development token (no sign-in).
const devWs = new URLSearchParams(location.search).get('ws')
if (devWs) {
  const lab = startLab(devWs, 'dev')
  createRoot(document.getElementById('root')!).render(<StrictMode><LabView lab={lab} started={window.__labReady!} /></StrictMode>)
} else {
  const renderApp = () => createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
  if (isDesktop) void restoreDesktopSettings().catch(error => console.warn('Could not restore device preferences', error)).then(renderApp)
  else renderApp()
}
