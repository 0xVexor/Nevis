import { useEffect, useState } from 'react'
import { allBlocksTemplate } from '@nevis/editor'
import { Button, IconButton, Icon, Row, Toast } from './ds'
import { DatabaseView } from './DatabaseView'
import { EditorPane } from './EditorPane'
import { PageTreeView } from './PageTreeView'
import { t } from './i18n'
import { go, useRoute } from './router'
import { readSynced } from './workspaceSettings'
import type { Workspace, WsStatus } from './workspace'
import { AllPages } from './views/AllPages'
import { Home } from './views/Home'
import { Palette } from './views/Palette'
import { Settings } from './views/Settings'
import { Templates } from './views/Templates'

const ago = (ms: number) => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 1000))} ثانیه پیش` : 'هنوز نه')

/** The app: a header with the sync status, a sidebar (navigation, new, tree, trash) and the screen of the current route. */
export function WorkspaceView({ ws, onSignOut }: { ws: Workspace; onSignOut?: () => void }) {
  const route = useRoute()
  const [, redraw] = useState(0)
  const [status, setStatus] = useState<WsStatus | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [palette, setPalette] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const selected = route.name === 'page' ? route.id : ''
  const select = (id: string) => { go({ name: 'page', id }); setShowTrash(false); setNavOpen(false) }

  const create = async (parent: string) => { const id = await ws.newPage(parent); select(id) }
  const createDb = async () => { const id = await ws.newDatabase(''); select(id) }
  const createAllBlocks = async () => { const id = await ws.newTemplatePage('همهٔ بلوک‌ها', allBlocksTemplate()); select(id) }

  useEffect(() => {
    ws.onOpenPage = id => { if (ws.tree.byId.has(id)) select(id); else ws.notify('صفحه پیدا نشد') }
    const refresh = () => { redraw(n => n + 1); void ws.status().then(setStatus) }
    const off = ws.subscribe(refresh)
    const timer = setInterval(refresh, 1000)
    refresh()
    // the last chance to save: the tab is hidden or closing (the 300 ms throttle must not lose the last words)
    const hide = () => { if (document.visibilityState === 'hidden') void ws.flushAll() }
    const pagehide = () => void ws.flushAll()
    document.addEventListener('visibilitychange', hide)
    addEventListener('pagehide', pagehide)
    // Shortcuts use PHYSICAL keys (event.code), so they work with any keyboard language: Ctrl/⌘ K, Alt N, Alt H
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); setPalette(p => !p) }
      else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); void create('') }
      else if (e.altKey && e.code === 'KeyH') { e.preventDefault(); go({ name: 'home' }) }
    }
    addEventListener('keydown', keys)
    return () => { off(); clearInterval(timer); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', pagehide); removeEventListener('keydown', keys) }
  }, [ws]) // eslint-disable-line react-hooks/exhaustive-deps

  const page = selected ? ws.tree.byId.get(selected)?.page : undefined
  const calendar = readSynced(ws).calendar
  const screen = (() => {
    if (route.name === 'page') {
      if (!page) return <p className="small screen">{ws.data.pages.find(p => p.id === selected)?.trashed ? 'این صفحه در سطل زباله است (از نوار کنار بازگردانی کنید).' : 'صفحه پیدا نشد.'}</p>
      return (
        <>
          <div className="bar" data-testid="page-actions">
            <Button size="sm" onClick={() => void create(page.id)}>زیرصفحه</Button>
            <Button size="sm" onClick={() => void ws.moveUp(page.id)}>بالا</Button>
            <Button size="sm" onClick={() => void ws.moveDown(page.id)}>پایین</Button>
            <Button size="sm" onClick={() => void ws.indent(page.id)}>تورفتگی</Button>
            <Button size="sm" onClick={() => void ws.outdent(page.id)}>برگشت</Button>
            <Button size="sm" variant="danger" onClick={() => { void ws.trash(page.id); go({ name: 'home' }) }}>حذف</Button>
          </div>
          {page.type === 'database' ? <DatabaseView key={page.id} ws={ws} id={page.id} /> : <EditorPane key={`${page.id}:${ws.reopenCount(page.id)}`} ws={ws} id={page.id} title={page.title} />}
        </>
      )
    }
    if (route.name === 'all') return <AllPages ws={ws} calendar={calendar} />
    if (route.name === 'templates') return <Templates ws={ws} />
    if (route.name === 'settings') return <Settings ws={ws} />
    return <Home ws={ws} onNewPage={() => void create('')} onNewDatabase={() => void createDb()} />
  })()

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')} dir="rtl">
      <header className="top">
        <IconButton label="منو" className="nav-toggle" onClick={() => setNavOpen(o => !o)}><Icon name="list" /></IconButton>
        <strong>نِویس</strong>
        <IconButton label={t('Search or run a command')} data-testid="open-palette" onClick={() => setPalette(true)}><Icon name="search" /></IconButton>
        <span data-testid="net" data-online={status?.online ?? false}>{status?.online ? `● ${t('Online')}` : `○ ${t('Offline')}`}</span>
        <span>{t('Not sent yet')}: <b data-testid="outbox">{status?.outbox ?? 0}</b>{status && status.unsaved > 0 ? ` (+${status.unsaved} ذخیره‌نشده)` : ''}</span>
        <span>{t('Last sync')}: {ago(status?.lastSyncAt ?? 0)}</span>
        <span title="navigator.storage.persist()">ماندگار: {String(status?.persisted)}</span>
        {status?.lastError && <span className="err" data-testid="sync-error">{status.lastError}</span>}
        {onSignOut && <Button size="sm" data-testid="signout" onClick={onSignOut}>{t('Sign out')}</Button>}
      </header>
      <div className="cols">
        <nav className="side" aria-label="صفحه‌ها">
          <Row as="button" icon={<Icon name="home" />} text={t('Home')} data-testid="nav-home" onClick={() => { go({ name: 'home' }); setNavOpen(false) }} />
          <Row as="button" icon={<Icon name="folder" />} text={t('All pages')} data-testid="nav-all" onClick={() => { go({ name: 'all' }); setNavOpen(false) }} />
          <Row as="button" icon={<Icon name="templates" />} text={t('Templates')} data-testid="nav-templates" onClick={() => { go({ name: 'templates' }); setNavOpen(false) }} />
          <Row as="button" icon={<Icon name="settings" />} text={t('Settings')} data-testid="nav-settings" onClick={() => { go({ name: 'settings' }); setNavOpen(false) }} />
          <hr />
          <div className="row">
            <Button size="sm" variant="primary" data-testid="new-page" onClick={() => void create('')}>صفحهٔ تازه</Button>
            <Button size="sm" data-testid="new-database" onClick={() => void createDb()}>پایگاه‌داده</Button>
            <Button size="sm" data-testid="new-all-blocks" onClick={() => void createAllBlocks()}>نمونهٔ همهٔ بلوک‌ها</Button>
            <Button size="sm" onClick={() => setShowTrash(s => !s)} data-testid="trash-toggle">سطل زباله ({ws.tree.trash.length})</Button>
          </div>
          <PageTreeView ws={ws} selected={selected} onSelect={select} />
          {showTrash && (
            <ul className="trash" data-testid="trash">
              {ws.tree.trash.length === 0 && <li className="small">{t('Your trash is empty')}</li>}
              {ws.tree.trash.map(p => <li key={p.id}>{p.title || 'بدون عنوان'} <Button size="sm" onClick={() => void ws.restore(p.id)}>بازگردانی</Button></li>)}
            </ul>
          )}
        </nav>
        <main className="main">{screen}</main>
      </div>
      {palette && <Palette ws={ws} onClose={() => setPalette(false)} onNewPage={() => void create('')} onNewDatabase={() => void createDb()} />}
      {ws.notice && <Toast msg={ws.notice} onClose={() => ws.notify('')} />}
    </div>
  )
}
