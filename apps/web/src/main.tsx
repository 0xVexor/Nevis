import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_WS, Lab, type Note, type Status } from './lab'
import './style.css'

declare global { interface Window { __lab?: Lab; __labReady?: Promise<void> } }

const ws = new URLSearchParams(location.search).get('ws') ?? DEFAULT_WS
const lab = new Lab(ws)
window.__lab = lab
// started once, outside React (StrictMode runs effects twice in development, which would create two coordinators)
const started = lab.start()
window.__labReady = started

function App() {
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

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
