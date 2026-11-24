import { useEffect, useRef, useState } from 'react'
import { isDue } from '@nevis/core'
import { Button, Toast } from './ds'
import { DatabaseView } from './DatabaseView'
import { DatabaseRowPeek } from './DatabaseRowPeek'
import { EditorPane } from './EditorPane'
import { AppShell } from './shell/AppShell'
import { HomeRoute } from './screens/HomeRoute'
import { Trash } from './screens/Trash'
import { Flashcards } from './screens/Flashcards'
import { History } from './screens/History'
import { legacyPages } from './shell/adapt'
import { getTemplates, templateDoc } from './shell/oldTemplates'
import { t } from './i18n'
import { go, useRoute } from './router'
import { matches } from './shortcutBindings'
import { readSynced } from './workspaceSettings'
import type { Workspace, WsStatus } from './workspace'
import { PagesTable } from './screens/PagesTable'
import { Settings } from './views/Settings'
import { Graph } from './views/Graph'
import { Tasks } from './screens/Tasks'
import { Templates } from './views/Templates'
import { Files } from './views/Files'
import { RowPage } from './RowPage'
import { BoardPage } from './BoardPage'
import { Databases, Drawings } from './views/Databases'

/** The app: a header with the sync status, a sidebar (navigation, new, tree, trash) and the screen of the current route. */
export function WorkspaceView({ ws, onSignOut, onWorkspaces, workspaceName }: { ws: Workspace; onSignOut?: () => void; onWorkspaces?: () => void; workspaceName?: string }) {
  const route = useRoute()
  const [, redraw] = useState(0)
  const [status, setStatus] = useState<WsStatus | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [palette, setPalette] = useState(false)
  const [peek, setPeek] = useState<{ db: string; row: string } | null>(null)
  const [history, setHistory] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null)
  const toastRef = useRef(toast)
  toastRef.current = toast
  useEffect(() => { const f = (e: Event) => setToast((e as CustomEvent<{ msg: string; undo?: () => void }>).detail); window.addEventListener('app-toast', f); return () => window.removeEventListener('app-toast', f) }, [])
  const selected = route.name === 'page' ? route.id : ''
  const activePeek = peek?.db === selected ? peek : null
  useEffect(() => { if (!activePeek) setPeek(null) }, [activePeek])
  // flashcards due now (the badge on the rail): a fold over the reviews, refreshed when the data changes and now and then (cards fall due with time)
  const [due, setDue] = useState(0)
  useEffect(() => {
    let live = true
    const count = () => void ws.reviewData().then(d => { if (live) setDue(ws.search.cards().filter(c => isDue(d.recs.get(c.id), Date.now())).length) })
    count(); const off = ws.subscribe(count); const timer = setInterval(count, 60_000)
    return () => { live = false; off(); clearInterval(timer) }
  }, [ws])
  const lastPage = useRef('') // the page the graph centres on when it is opened from elsewhere
  if (selected) lastPage.current = selected
  const select = (id: string) => { go({ name: 'page', id }); setShowTrash(false); setNavOpen(false) }

  const create = async (parent: string) => { const id = await ws.newPage(parent); select(id) }
  const createDb = async () => { const id = await ws.newDatabase(''); select(id) }

  useEffect(() => {
    ws.onOpenPage = id => { if (ws.tree.byId.has(id)) select(id); else ws.notify(t('Page not found')) }
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
      if (e.defaultPrevented || document.querySelector('.dv-peek-layer')) return
      if (matches(e, 'search')) { e.preventDefault(); setPalette(p => !p) }
      else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); void create('') }
      else if (e.altKey && e.code === 'KeyH') { e.preventDefault(); go({ name: 'home' }) }
    }
    // Ctrl/⌘ Z right after a toast that offers Undo runs it (outside text fields, where Z undoes typing)
    const undo = (e: KeyboardEvent) => { if (!e.defaultPrevented && !document.querySelector('.dv-peek-layer, [role="dialog"], .ds-pop') && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ' && toastRef.current?.undo && !(e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable=true]')) { e.preventDefault(); toastRef.current.undo(); setToast(null) } }
    addEventListener('keydown', undo)
    addEventListener('keydown', keys)
    return () => { off(); clearInterval(timer); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', pagehide); removeEventListener('keydown', keys); removeEventListener('keydown', undo) }
  }, [ws]) // eslint-disable-line react-hooks/exhaustive-deps

  const page = selected ? ws.tree.byId.get(selected)?.page : undefined
  const calendar = readSynced(ws).calendar
  const screen = (() => {
    if (route.name === 'page') {
      if (!page) return <p className="small screen">{ws.data.pages.find(p => p.id === selected)?.trashed ? t('This page is in the trash (restore it from the trash screen).') : t('Page not found.')}</p>
      if (ws.isFolder(page.id)) return <Files ws={ws} initialFolder={page.id} />
      return (
        <>
          {ws.isBoard(page.id) ? <BoardPage key={page.id} ws={ws} id={page.id} title={page.title} /> : page.type === 'database' ? <DatabaseView key={page.id} ws={ws} id={page.id} onPeek={row => setPeek({ db: page.id, row })} /> : <EditorPane key={`${page.id}:${ws.reopenCount(page.id)}`} ws={ws} id={page.id} title={page.title} />}
        </>
      )
    }
    if (route.name === 'all') return <div data-testid="all-pages"><PagesTable pages={legacyPages(ws).filter(p => !p.deletedAt)} onOpen={select} onStatus={(id, st) => void ws.setMeta(id, { status: st ?? '' })} onClose={() => undefined} /></div>
    if (route.name === 'templates') return <Templates ws={ws} />
    if (route.name === 'settings') return <Settings ws={ws} initialTab={route.tab} onTabChange={tab => go({ name: 'settings', tab })} />
    if (route.name === 'row') return <RowPage key={route.id} ws={ws} dbId={route.db} id={route.id} />
    if (route.name === 'databases') return <Databases ws={ws} />
    if (route.name === 'drawings') return <Drawings ws={ws} />
    if (route.name === 'files') return <Files ws={ws} />
    if (route.name === 'graph') return <Graph ws={ws} currentId={lastPage.current || undefined} />
    if (route.name === 'cards') return <Flashcards ws={ws} />
    if (route.name === 'tasks') return <Tasks ws={ws} />
    if (route.name === 'trash') return <div data-testid="trash"><Trash items={legacyPages(ws).filter(p => p.deletedAt)} onRestore={id => void ws.restore(id)} onPurge={page => { if (confirm(t('Delete “{title}” permanently? This cannot be undone on any device.', { title: page.title || t('Untitled') }))) void ws.purge(page.id) }} onEmpty={() => { if (confirm(t('Delete everything in the trash permanently? This cannot be undone.'))) void ws.emptyTrash() }} /></div>
    return <HomeRoute ws={ws} onOpen={select} onNewPage={() => void create('')} onTemplate={templateId => {
      const template = getTemplates().find(item => item.id === templateId)
      if (!template) return
      void ws.newTemplatePage(template.pageTitle, templateDoc(template)).then(async id => {
        await ws.setMeta(id, { icon: template.icon })
        select(id)
      }).catch(() => ws.notify(t('Could not complete the action. Please try again.')))
    }} onWorkspaces={onWorkspaces} />
  })()

  return (
    <>
      <AppShell
        ws={ws} route={route} status={status} onSearch={() => setPalette(true)} searchOpen={palette && !activePeek} onCloseSearch={() => setPalette(false)} onNewPage={p => void create(p)} onNewDatabase={() => void createDb()}
        onOpen={select} onSignOut={onSignOut} onWorkspaces={onWorkspaces} workspaceName={workspaceName} dueCards={due} onHistory={() => setHistory(true)}
      >
        {screen}
      </AppShell>
      {activePeek && <DatabaseRowPeek key={activePeek.row} ws={ws} dbId={activePeek.db} rowId={activePeek.row}
        onClose={() => setPeek(null)} onFullPage={() => { setPeek(null); go({ name: 'row', db: activePeek.db, id: activePeek.row }) }} />}
      {history && route.name === 'page' && <History ws={ws} id={route.id} title={ws.tree.byId.get(route.id)?.page.title ?? ''} onClose={() => setHistory(false)} />}
      {ws.notice && <Toast msg={ws.notice} onClose={() => ws.notify('')} />}
      {toast && <Toast msg={toast.msg} action={toast.undo ? t('Undo') : undefined} actionHint="Ctrl+Z" onAction={toast.undo} onClose={() => setToast(null)} />}
    </>
  )
}
