import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { uuidv7 } from '@nevis/protocol'
import { AuthError, createWorkspace, deviceLabel, me, signIn, signOut, signUp, workspaces, type Me, type WorkspaceInfo } from './auth'
import { Lab, type Note, type Status } from './lab'
import { appInfo, isDesktop, onWindowFlush, setServer } from './desktop'
import { installTranslator } from './i18n'
import { apply as applyDeviceSettings } from './deviceSettings'
import { Workspace } from './workspace'
import { WorkspaceView } from './WorkspaceView'
import './ds/tokens.css'
import './ds/components.css'
import './ds/navigation.css'
import './ds/preferences.css'
import './ds/home.css'
import './ds/commands.css'
import '@fontsource/vazirmatn/400.css'
import '@fontsource/vazirmatn/700.css'
import 'katex/dist/katex.min.css'
import '@nevis/editor/editor.css'
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
  if (!ready || !status) return <main><p>در حال باز کردن…</p></main>
  const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`)
  return (
    <main dir="rtl">
      <h1>M3 — آزمایشگاه ذخیره‌سازی</h1>
      {onSignOut && <button data-testid="signout" onClick={onSignOut}>خروج</button>}
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
    const m: Record<string, string> = { bad_credentials: 'نام کاربری یا گذرواژه درست نیست', rate_limited: 'تلاش بیش از حد؛ کمی بعد دوباره امتحان کنید', username_taken: 'این نام کاربری گرفته شده', registration_closed: 'این سرور حساب تازه نمی‌پذیرد', bad_invite: 'کد دعوت درست نیست', weak_password: 'گذرواژه ضعیف است' }
    return m[e.code] ?? e.message
  }
  return 'سرور در دسترس نیست'
}

function SignInForm({ onDone }: { onDone: (recoveryKey?: string) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    const f = new FormData(ev.currentTarget)
    const u = String(f.get('username') ?? '').trim(), p = String(f.get('password') ?? ''), inv = String(f.get('invite') ?? '')
    setBusy(true); setErr('')
    try {
      if (mode === 'in') { await signIn(u, p, deviceLabel()); onDone() }
      else { const r = await signUp(u, p, deviceLabel(), inv); onDone(r.recoveryKey) }
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <main dir="rtl">
      <h1>{mode === 'in' ? 'ورود' : 'ساخت حساب'}</h1>
      <form onSubmit={e => void submit(e)} data-testid="auth-form">
        <label>نام کاربری <input name="username" autoComplete="username" required dir="ltr" /></label>
        <label>گذرواژه <input name="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required dir="ltr" /></label>
        {mode === 'up' && <label>کد دعوت (اگر لازم است) <input name="invite" dir="ltr" /></label>}
        <button type="submit" disabled={busy} data-testid="auth-submit">{busy ? '…' : mode === 'in' ? 'ورود' : 'ساخت حساب'}</button>
        {err && <p className="err" role="alert" data-testid="auth-error">{err}</p>}
      </form>
      <button type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr('') }}>{mode === 'in' ? 'حساب ندارم' : 'حساب دارم'}</button>
    </main>
  )
}

/** Signed in: pick (or create) a workspace, then open it. */
function Home({ who, recoveryKey, onSignedOut }: { who: Me; recoveryKey?: string; onSignedOut: () => void }) {
  const [list, setList] = useState<WorkspaceInfo[] | null>(null)
  const [open, setOpen] = useState<{ ws: Workspace } | null>(null)
  const [key, setKey] = useState(recoveryKey)
  useEffect(() => { void workspaces().then(setList, () => setList([])) }, [])
  const leave = async () => { await open?.ws.stop(); await signOut().catch(() => undefined); onSignedOut() }
  const enter = (id: string) => {
    const ws = new Workspace(id, null)
    ;(window as unknown as { __ws?: Workspace }).__ws = ws
    void ws.start().then(() => setOpen({ ws }))
    // desktop: closing the window writes what is still waiting and pushes the outbox first (at most 5 s, ADR-0007 §7)
    if (isDesktop) void onWindowFlush(async () => { await ws.flushAll(); await Promise.race([ws.rt.engine.cycle().catch(() => undefined), new Promise(r => setTimeout(r, 4000))]) })
  }
  const make = async () => { const id = uuidv7(); await createWorkspace(id, 'یادداشت‌ها'); enter(id) }
  if (open) return <WorkspaceView ws={open.ws} onSignOut={() => void leave()} />
  return (
    <main dir="rtl">
      <h1>سلام {who.account.username}</h1>
      {key && <div className="recovery" data-testid="recovery"><p>کلید بازیابی شما (فقط یک بار نشان داده می‌شود؛ جایی امن نگه دارید):</p><code dir="ltr">{key}</code> <button onClick={() => setKey(undefined)}>نوشتم</button></div>}
      {list === null ? <p>در حال بارگذاری…</p> : (
        <ul data-testid="ws-list">{list.map(w => <li key={w.id}><button onClick={() => enter(w.id)}>{w.name}</button> <span className="small">{w.role}</span></li>)}</ul>
      )}
      <button data-testid="ws-new" onClick={() => void make()}>فضای کار تازه</button>
      <button data-testid="signout" onClick={() => void leave()}>خروج</button>
    </main>
  )
}

/** Desktop only: which server this app talks to (the one address JavaScript may name; Rust checks it). */
function ServerForm({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState('')
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    try { await setServer(String(new FormData(ev.currentTarget).get('server') ?? '')); onDone() } catch (e) { setErr(String(e)) }
  }
  return (
    <main dir="rtl">
      <h1>آدرس سرور</h1>
      <form onSubmit={e => void submit(e)} data-testid="server-form">
        <label>آدرس سرور شما <input name="server" dir="ltr" placeholder="https://notes.example.com" required /></label>
        <button type="submit">ادامه</button>
        {err && <p className="err" role="alert">{err}</p>}
      </form>
    </main>
  )
}

function Root() {
  const [state, setState] = useState<'loading' | 'server' | 'out' | { me: Me; recoveryKey?: string }>('loading')
  const refresh = async (recoveryKey?: string) => {
    if (isDesktop && !(await appInfo()).server) { setState('server'); return }
    await me().then(m => setState(m ? { me: m, recoveryKey } : 'out'), () => setState('out'))
  }
  useEffect(() => { void refresh() }, [])
  if (state === 'loading') return <main><p>در حال باز کردن…</p></main>
  if (state === 'server') return <ServerForm onDone={() => void refresh()} />
  if (state === 'out') return <SignInForm onDone={k => void refresh(k)} />
  return <Home who={state.me} recoveryKey={state.recoveryKey} onSignedOut={() => setState('out')} />
}

// Tests and the old lab: `?ws=<id>` opens that workspace at once with the development token (no sign-in).
const devWs = new URLSearchParams(location.search).get('ws')
if (devWs) {
  const lab = startLab(devWs, 'dev')
  createRoot(document.getElementById('root')!).render(<StrictMode><LabView lab={lab} started={window.__labReady!} /></StrictMode>)
} else {
  createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
}
