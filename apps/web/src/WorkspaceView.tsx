import { useEffect, useState } from 'react'
import { DatabaseView } from './DatabaseView'
import { EditorPane } from './EditorPane'
import { PageTreeView } from './PageTreeView'
import type { Workspace, WsStatus } from './workspace'

const ago = (t: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} ثانیه پیش` : 'هنوز نه')

export function WorkspaceView({ ws, onSignOut }: { ws: Workspace; onSignOut?: () => void }) {
  const [, redraw] = useState(0)
  const [status, setStatus] = useState<WsStatus | null>(null)
  const [selected, setSelected] = useState('')
  const [showTrash, setShowTrash] = useState(false)
  useEffect(() => {
    ws.onOpenPage = id => { if (ws.tree.byId.has(id)) setSelected(id); else ws.notify('صفحه پیدا نشد') }
    const refresh = () => { redraw(n => n + 1); void ws.status().then(setStatus) }
    const off = ws.subscribe(refresh)
    const t = setInterval(refresh, 1000)
    refresh()
    // the last chance to save: the tab is hidden or closing (the 300 ms throttle must not lose the last words)
    const hide = () => { if (document.visibilityState === 'hidden') void ws.flushAll() }
    const pagehide = () => void ws.flushAll()
    document.addEventListener('visibilitychange', hide)
    addEventListener('pagehide', pagehide)
    return () => { off(); clearInterval(t); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', pagehide) }
  }, [ws])

  const page = selected ? ws.tree.byId.get(selected)?.page : undefined
  const create = async (parent: string) => { const id = await ws.newPage(parent); setSelected(id) }
  const createDb = async () => { const id = await ws.newDatabase(''); setSelected(id) }
  return (
    <div className="app" dir="rtl">
      <header className="top">
        <strong>نِویس</strong>
        <span data-testid="net" data-online={status?.online ?? false}>{status?.online ? '● آنلاین' : '○ آفلاین'}</span>
        <span>ارسال‌نشده: <b data-testid="outbox">{status?.outbox ?? 0}</b>{status && status.unsaved > 0 ? ` (+${status.unsaved} ذخیره‌نشده)` : ''}</span>
        <span>آخرین همگام‌سازی: {ago(status?.lastSyncAt ?? 0)}</span>
        <span title="navigator.storage.persist()">ماندگار: {String(status?.persisted)}</span>
        {status?.lastError && <span className="err" data-testid="sync-error">{status.lastError}</span>}
        {ws.notice && <span className="notice" role="status" data-testid="notice">{ws.notice}</span>}
        {onSignOut && <button data-testid="signout" onClick={onSignOut}>خروج</button>}
      </header>
      <div className="cols">
        <nav className="side">
          <div className="row">
            <button data-testid="new-page" onClick={() => void create('')}>صفحهٔ تازه</button>
            <button data-testid="new-database" onClick={() => void createDb()}>پایگاه‌داده</button>
            <button onClick={() => setShowTrash(s => !s)} data-testid="trash-toggle">سطل زباله ({ws.tree.trash.length})</button>
          </div>
          <PageTreeView ws={ws} selected={selected} onSelect={id => { setSelected(id); setShowTrash(false) }} />
          {showTrash && (
            <ul className="trash" data-testid="trash">
              {ws.tree.trash.map(p => <li key={p.id}>{p.title || 'بدون عنوان'} <button onClick={() => void ws.restore(p.id)}>بازگردانی</button></li>)}
            </ul>
          )}
        </nav>
        <main className="main">
          {page ? (
            <>
              <div className="bar" data-testid="page-actions">
                <button onClick={() => void create(page.id)}>زیرصفحه</button>
                <button onClick={() => void ws.moveUp(page.id)}>بالا</button>
                <button onClick={() => void ws.moveDown(page.id)}>پایین</button>
                <button onClick={() => void ws.indent(page.id)}>تورفتگی</button>
                <button onClick={() => void ws.outdent(page.id)}>برگشت</button>
                <button onClick={() => { void ws.trash(page.id); setSelected('') }}>حذف</button>
              </div>
              {page.type === 'database' ? <DatabaseView key={page.id} ws={ws} id={page.id} /> : <EditorPane key={`${page.id}:${ws.reopenCount(page.id)}`} ws={ws} id={page.id} title={page.title} />}
            </>
          ) : <p className="small">یک صفحه را انتخاب یا بسازید.</p>}
        </main>
      </div>
    </div>
  )
}
