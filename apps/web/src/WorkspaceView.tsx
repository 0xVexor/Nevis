import { useEffect, useState } from 'react'
import { allBlocksTemplate } from '@nevis/editor'
import { Button, Toast } from './ds'
import { DatabaseView } from './DatabaseView'
import { EditorPane } from './EditorPane'
import { AppShell } from './shell/AppShell'
import { HomeRoute } from './screens/HomeRoute'
import { Trash } from './screens/Trash'
import { Flashcards } from './screens/Flashcards'
import { History } from './screens/History'
import { legacyPages } from './shell/adapt'
import { t } from './i18n'
import { go, useRoute } from './router'
import { readSynced } from './workspaceSettings'
import type { Workspace, WsStatus } from './workspace'
import { AllPages } from './views/AllPages'
import { Palette } from './views/Palette'
import { Settings } from './views/Settings'
import { Graph } from './views/Graph'
import { Backlinks } from './views/Backlinks'
import { Tasks } from './views/Tasks'
import { Templates } from './views/Templates'

/** The app: a header with the sync status, a sidebar (navigation, new, tree, trash) and the screen of the current route. */
export function WorkspaceView({ ws, onSignOut }: { ws: Workspace; onSignOut?: () => void }) {
  const route = useRoute()
  const [, redraw] = useState(0)
  const [status, setStatus] = useState<WsStatus | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [palette, setPalette] = useState(false)
  const [history, setHistory] = useState(false)
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
          {page.type === 'database' ? <div className="page-cols"><div className="page"><DatabaseView key={page.id} ws={ws} id={page.id} /></div></div> : <EditorPane key={`${page.id}:${ws.reopenCount(page.id)}`} ws={ws} id={page.id} title={page.title} />}
          {page.type !== 'database' && <Backlinks ws={ws} id={page.id} />}
        </>
      )
    }
    if (route.name === 'all') return <AllPages ws={ws} calendar={calendar} />
    if (route.name === 'templates') return <Templates ws={ws} />
    if (route.name === 'settings') return <Settings ws={ws} />
    if (route.name === 'graph') return <Graph ws={ws} />
    if (route.name === 'cards') return <Flashcards ws={ws} />
    if (route.name === 'tasks') return <Tasks ws={ws} />
    if (route.name === 'trash') return <div data-testid="trash"><Trash items={legacyPages(ws).filter(p => p.deletedAt)} days={30} onRestore={id => void ws.restore(id)} onPurge={page => { if (confirm(`«${page.title || 'بدون عنوان'}» برای همیشه حذف شود؟ این کار در هیچ دستگاهی قابل بازگشت نیست.`)) void ws.purge(page.id) }} onEmpty={() => { if (confirm('همهٔ صفحه‌های سطل برای همیشه حذف شوند؟ این کار قابل بازگشت نیست.')) void ws.emptyTrash() }} /></div>
    return <HomeRoute ws={ws} onOpen={select} onNewPage={() => void create('')} onTemplate={() => go({ name: 'templates' })} />
  })()

  return (
    <>
      <AppShell
        ws={ws} route={route} status={status} onSearch={() => setPalette(true)} onNewPage={p => void create(p)} onNewDatabase={() => void createDb()} onNewAllBlocks={() => void createAllBlocks()}
        onOpen={select} onSignOut={onSignOut} onHistory={() => setHistory(true)}
      >
        {screen}
      </AppShell>
      {history && route.name === 'page' && <History ws={ws} id={route.id} title={ws.tree.byId.get(route.id)?.page.title ?? ''} onClose={() => setHistory(false)} />}
      {palette && <Palette ws={ws} onClose={() => setPalette(false)} onNewPage={() => void create('')} onNewDatabase={() => void createDb()} />}
      {ws.notice && <Toast msg={ws.notice} onClose={() => ws.notify('')} />}
    </>
  )
}
