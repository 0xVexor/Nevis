// The frame of the app, composed from the old app's three regions: the rail (nav.side), the side panel (aside.context-panel) and the main
// column (header.topbar + .scroller). Markup and class names are the old ones, so the copied stylesheets (ds/areas) apply as they did there;
// only the data comes from the new layer (shell/adapt.ts). The regions live in Rail.tsx, ContextPanel.tsx and Topbar.tsx.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { updateSavedSearch } from '@nevis/core'
import { Icon, IconButton, Menu, type MenuItem } from '../ds'
import { t } from '../i18n'
import { go, href, type Route } from '../router'
import { isDark, updateSettings, useSettings } from '../deviceSettings'
import { download } from '../download'
import type { Workspace, WsStatus } from '../workspace'
import { legacyPages } from './adapt'
import { bindingHint, matches } from '../shortcutBindings'
import { commandMatches, matchesSidebarShortcut } from '../shortcutCommands'
import { ContextPanel } from './ContextPanel'
import { PageChrome } from './pageChrome'
import { PagePanel } from './PagePanel'
import { ReaderBar, loadReaderCfg, type ReaderCfg } from './ReaderBar'
import { buildIndex } from './pageIndex'
import { PanelHost } from './panelHost'
import { Rail, RAIL_MIN, RAIL_MAX } from './Rail'
import { Palette, type SearchCommand } from '../views/Palette'
import { editorSearchItems } from '../editor/slash'
import { runEditorCommand } from '../editor/commandPalette'
import type { Editor } from '@tiptap/core'
import { Topbar } from './Topbar'
import { useNavHistory } from './useNavHistory'
import { PageContextMenu } from './pageContextMenu'
import { usePageActions } from './usePageActions'

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const PAGE_W = { min: 640, max: 1800, def: 1400, step: 80 } // the text column's width, the old app's limits
const PANEL_TITLES: Record<string, string> = { tasks: 'Tasks', settings: 'Settings' }

/** A number kept on this device (a panel's width): null = the stylesheet's own size. */
function useStoredNumber(key: string, min: number, max: number): [number | null, (v: number | null) => void] {
  const [v, setV] = useState<number | null>(() => { try { const n = Number(localStorage.getItem(key)); return n ? Math.min(max, Math.max(min, n)) : null } catch { return null } })
  return [v, (n: number | null) => { setV(n); try { n === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(n)) } catch { /* private window */ } }]
}

export interface ShellProps {
  ws: Workspace
  route: Route
  status: WsStatus | null
  children: ReactNode
  onSearch: () => void
  searchOpen: boolean
  onCloseSearch: () => void
  onNewPage: (parent: string) => void
  onNewDatabase: () => void
  onNewTodo?: () => void
  onOpen: (id: string) => void
  onSignOut?: () => void
  /** back to the list of workspaces */
  onWorkspaces?: () => void
  /** the name on the workspace card */
  workspaceName?: string
  /** the page's history (the clock in the top bar) */
  onHistory?: () => void
  /** flashcards due now (the badge on the rail) */
  dueCards?: number
  /** a page's own tools in the top bar (reader mode, the page side panel) */
  pageTools?: ReactNode
  save?: 'idle' | 'saving' | 'saved' | 'error'
}

export function AppShell({ ws, route, status, children, onSearch, searchOpen, onCloseSearch, onNewPage, onNewDatabase, onNewTodo, onOpen, onSignOut, onWorkspaces, workspaceName, onHistory, dueCards = 0, pageTools, save = 'saved' }: ShellProps) {
  const settings = useSettings()
  const [rowMenu, setRowMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [searchInit, setSearchInit] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [railW, setRailW] = useStoredNumber('nevis.railW', RAIL_MIN, RAIL_MAX)
  const [sideW, setSideW] = useStoredNumber('nevis.sideW', 240, 600)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  const panel = route.name === 'tasks' || route.name === 'settings' ? route.name : 'vault'
  const [panelVisibility, setPanelVisibility] = useState<Record<string, boolean>>(() => {
    try { return { vault: true, tasks: true, settings: true, ...JSON.parse(localStorage.getItem('nevis.contextPanels') || '{}') } } catch { return { vault: true, tasks: true, settings: true } }
  })
  const wide = panelVisibility[panel] !== false
  const setWide = (open: boolean) => setPanelVisibility(previous => ({ ...previous, [panel]: open }))
  useEffect(() => { try { localStorage.setItem('nevis.contextPanels', JSON.stringify(panelVisibility)) } catch { /* private window */ } }, [panelVisibility])
  const [drawer, setDrawer] = useState(false)
  const [fullScreen, setFullScreen] = useState(!!document.fullscreenElement)
  const [drawerOpen, setDrawerOpen] = useState(false) // the page's own side panel (opposite the pages panel)
  const [reader, setReader] = useState(false)
  const [readerCfg, setReaderCfg] = useState<ReaderCfg>(loadReaderCfg)
  const [pageW, setPageW] = useState<number>(() => { try { return Number(localStorage.getItem('nevis.page.width')) || PAGE_W.def } catch { return PAGE_W.def } })
  const savePageW = (w: number) => { setPageW(w); try { localStorage.setItem('nevis.page.width', String(w)) } catch { /* private window */ } }
  useEffect(() => { const m = matchMedia('(max-width: 760px)'); const f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  useEffect(() => { const f = () => setFullScreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f) }, [])
  const panelOpen = narrow ? drawer : wide
  const togglePanel = () => (narrow ? setDrawer(o => !o) : setWide(!wide))
  const returnFocus = useRef<Element | null>(null)
  const restoreFocus = () => {
    const editor = document.querySelector<HTMLElement & { editor?: { commands: { focus: () => void } } }>('.main .ProseMirror')
    if (editor?.editor) editor.editor.commands.focus()
    else if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus()
  }
  const togglePanelFromKeys = () => {
    if (panelOpen) { togglePanel(); requestAnimationFrame(restoreFocus); return }
    returnFocus.current = document.activeElement
    togglePanel()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const aside = document.getElementById('workspace-context')
      ;(aside?.querySelector<HTMLElement>('.tree-in, [aria-current]:not([disabled])') ?? aside?.querySelector<HTMLElement>('.side-scroll button:not([disabled])'))?.focus()
    }))
  }
  const dark = isDark(settings)
  const currentId = route.name === 'page' ? route.id : ''
  const pages = useMemo(() => legacyPages(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => pages.filter(p => !p.deletedAt), [pages])
  const index = useMemo(() => buildIndex(live), [live])
  const byId = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages])
  const current = byId.get(currentId) ?? null
  useEffect(() => {
    if (!settings.treeAutoReveal || !currentId) return
    setSelected(currentId)
    setCollapsed(previous => {
      const next = new Set(previous)
      const seen = new Set<string>()
      for (let p = byId.get(currentId); p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
        seen.add(p.id)
        next.delete(p.id)
      }
      return next.size === previous.size ? previous : next
    })
  }, [currentId, settings.treeAutoReveal, byId])
  const crumbs = useMemo(() => {
    const out = []
    for (let p = byId.get(currentId), n = 0; p && n < 50; p = p.parentId ? byId.get(p.parentId) : undefined, n++) out.unshift(p)
    return out
  }, [byId, currentId])
  const nav = useNavHistory(href(route), useCallback((h: string) => { location.hash = h }, []))
  const open = (id: string) => { onOpen(id); setDrawer(false) }
  const pageActions = usePageActions(ws, pages, open, id => {
    go({ name: 'home' }); setSelected(id)
    setCollapsed(previous => {
      const next = new Set(previous)
      for (let parent = ws.tree.parentOf.get(id); parent; parent = ws.tree.parentOf.get(parent)) next.delete(parent)
      return next
    })
    if (narrow) setDrawer(true); else setWide(true)
  })
  const goTo = (name: Route['name']) => { go({ name } as Route); setDrawer(false) }
  const toggle = (id: string) => setCollapsed(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const boxes = () => live.filter(p => (index.kids.get(p.id) ?? []).length > 0 || p.kind === 'folder').map(p => p.id)

  const rowProps = {
    index, currentId, selectedId: selected, onSelect: setSelected, openOnClick: narrow || settings.treeSingleClick, collapsed, onToggle: toggle,
    onOpen: (id: string) => open(id), onAdd: (parent: string) => onNewPage(parent),
    onMenu: (id: string, rect: DOMRect) => setRowMenu({ id, rect }),
    onMove: (id: string, parentId: string | null, beforeId: string | null) => {
      const sibs = ws.children(parentId ?? '').map(n => n.page.id).filter(x => x !== id)
      void ws.moveTo(id, parentId ?? '', beforeId ? Math.max(0, sibs.indexOf(beforeId)) : sibs.length)
    },
  }
  const treeFrame = {
    label: t('Pages'), selectedId: selected, onSelect: setSelected, onOpen: (id: string) => open(id), onToggle: toggle, onMenu: rowProps.onMenu,
    isOpenBox: (id: string) => { const k = index.kids.get(id) ?? []; const pg = byId.get(id); return k.length || pg?.kind === 'folder' ? !collapsed.has(id) : null },
    parentOf: (id: string) => byId.get(id)?.parentId ?? null,
  }
  const rowItems = (id: string): MenuItem[] => [
    ...(byId.get(id)?.kind !== 'folder' ? [{ label: t('Open'), icon: <Icon name="external-link" size={16} />, onSelect: () => open(id) }] : []),
    { kind: 'sep' },
    { kind: 'head', label: 'Create' },
    { label: t('New subpage'), testid: 'menu-subpage', icon: <Icon name="plus" size={16} />, onSelect: () => onNewPage(id) },
    { label: 'Add folder', testid: 'menu-new-folder', icon: <Icon name="folder-plus" size={16} />, onSelect: () => pageActions.newFolder(id) },
    { label: 'Add board', testid: 'menu-new-board', icon: <Icon name="pencil" size={16} />, onSelect: () => void ws.newBoard(id).then(open).catch(() => ws.notify(t('Could not complete the action. Please try again.'))) },
    ...(byId.get(id)?.kind !== 'folder' ? [{ label: byId.get(id)?.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: <Icon name="star" size={16} />, onSelect: () => void ws.setMeta(id, { favorite: !byId.get(id)?.favorite }) }] : []),
    { kind: 'sep' },
    { kind: 'head', label: 'Organize' },
    ...(byId.has(id) ? pageActions.organizeItems(byId.get(id)!) : []),
    { kind: 'sep' },
    { label: t('Delete'), testid: 'menu-delete', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => { void ws.trash(id); if (id === currentId) go({ name: 'home' }) } },
  ]
  const panelKind = route.name === 'tasks' || route.name === 'settings' ? 'host' : 'vault'
  const toggleFullScreen = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined)
  // The side panel belongs to Home, a page, Tasks and Settings; every other screen fills the window (as in the old app)
  const overlay = !['home', 'page', 'row', 'tasks', 'settings'].includes(route.name)
  const iconsOnly = !narrow && settings.sidebar === 'icons'
  const onPage = route.name === 'page' && !!current && current.kind !== 'folder'
  const revealCurrent = () => { if (currentId) { setSelected(currentId); setCollapsed(c => { const n = new Set(c); for (let p = byId.get(currentId); p; p = p.parentId ? byId.get(p.parentId) : undefined) n.delete(p.id); return n }) } }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.dv-peek-layer, [role="dialog"], .ds-pop')) return
      const wider = matches(e, 'widerColumn')
      if (wider || matches(e, 'narrowerColumn')) { e.preventDefault(); savePageW(Math.min(PAGE_W.max, Math.max(PAGE_W.min, pageW + (wider ? PAGE_W.step : -PAGE_W.step)))) }
      if (matches(e, 'reader')) { e.preventDefault(); setReader(r => !r) }
      if (matchesSidebarShortcut(e)) { e.preventDefault(); togglePanelFromKeys() }
      if (commandMatches(e, 'Open Settings')) { e.preventDefault(); goTo('settings') }
      if (commandMatches(e, 'Reveal active note') && currentId) { e.preventDefault(); revealCurrent() }
      if (commandMatches(e, 'Full screen')) { e.preventDefault(); toggleFullScreen() }
      if (e.key === 'Escape' && narrow && drawer && !document.querySelector('.ds-pop, [role="dialog"]')) { setDrawer(false); requestAnimationFrame(restoreFocus) }
      if (reader && commandMatches(e, 'Leave reader mode') && !document.querySelector('.lightbox, .palette-overlay, .ds-pop, [role="dialog"]')) { e.preventDefault(); setReader(false) }
    }
    const toggleReader = () => setReader(r => !r)
    const history = () => onHistory?.()
    window.addEventListener('keydown', key); window.addEventListener('toggle-reader', toggleReader); window.addEventListener('open-history', history)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('toggle-reader', toggleReader); window.removeEventListener('open-history', history) }
  }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!onPage) setReader(false) }, [onPage])
  useEffect(() => { const f = () => { if (narrow) setDrawer(true); else setWide(true) }; window.addEventListener('nevis:show-tag', f); return () => window.removeEventListener('nevis:show-tag', f) }, [narrow])

  const onNewBoard = () => void ws.newBoard().then(open).catch(() => ws.notify(t('Could not complete the action. Please try again.')))
  const newTodo = onNewTodo ?? (() => void ws.newTodoList(t('New list')).then(open).catch(() => ws.notify(t('Could not complete the action. Please try again.'))))
  const paletteCommands = (): SearchCommand[] => {
    const entry = (id: string, label: string, group: string, icon: string, run: () => void, keywords?: string, hint?: string): SearchCommand =>
      ({ id, label, group, icon: <Icon name={icon} size={16} />, run, keywords, hint })
    const list = [
      entry('new-page', 'New page', 'Create', 'file', () => onNewPage(''), 'create add document صفحه جدید سند'),
      entry('new-folder', 'New folder', 'Create', 'folder', () => pageActions.newFolder(), 'create add پوشه'),
      entry('new-database', 'New database', 'Create', 'table', onNewDatabase, 'create add database table ساخت دیتابیس'),
      entry('new-board', 'New board', 'Create', 'pencil', onNewBoard, 'create drawing canvas ساخت بوم'),
      entry('new-todo', 'New to-do list', 'Create', 'checklist', newTodo, 'create tasks checklist ساخت فهرست کار'),
      entry('theme', dark ? 'Light mode' : 'Dark mode', 'Settings', dark ? 'sun' : 'moon', () => updateSettings({ theme: dark ? 'light' : 'dark' }), 'theme dark light روشن تاریک تم'),
      entry('full-screen', fullScreen ? 'Exit full screen' : 'Full screen', 'Settings', 'maximize', toggleFullScreen, 'fullscreen F11 تمام صفحه'),
      entry('page-list-style', settings.pagesView === 'compact' ? 'Show pages as a tree' : 'Show pages as a compact list', 'Settings', 'layers', () => updateSettings({ pagesView: settings.pagesView === 'compact' ? 'tree' : 'compact' }), 'tree compact sidebar درخت فشرده'),
      entry('backup-settings', 'Import or restore…', 'Data & backup', 'upload', () => go({ name: 'settings', tab: 'data' }), 'import restore backup zip پشتیبان بازیابی'),
      entry('export-workspace', 'Export the whole workspace', 'Data & backup', 'download', () => {
        void ws.exportMarkdown().then(bytes => download(bytes, 'nevis-markdown.zip')).catch(() => ws.notify(t('Could not complete the action. Please try again.')))
      }, 'export markdown backup zip دانلود خروجی'),
    ]
    if (onWorkspaces) list.push(entry('workspaces', 'Workspaces', 'Data & backup', 'vault', onWorkspaces, 'workspace switch account فضای کاری'))
    if (!overlay) list.push(entry('sidebar', panelOpen ? 'Hide side panel' : 'Show side panel', 'Settings', 'panel-left', togglePanel, 'sidebar navigation panel سایدبار نوار کنار', bindingHint('sidebar')))
    if (current && onPage) {
      list.push(
        entry('subpage', 'New subpage', 'Page actions', 'plus', () => onNewPage(current.id), 'create child زیرصفحه'),
        entry('favorite', current.favorite ? 'Remove from favorites' : 'Add to favorites', 'Page actions', 'star', () => void ws.setMeta(current.id, { favorite: !current.favorite }), 'favorite star علاقه مندی'),
        entry('history', 'Version history', 'Page actions', 'history', () => onHistory?.(), 'restore versions تاریخچه نسخه'),
        entry('reader', reader ? 'Leave reader mode' : 'Reader mode', 'Page actions', 'book', () => setReader(open => !open), 'read reading مطالعه', bindingHint('reader')),
        entry('page-panel', 'Page side panel (quick actions & navigation)', 'Page actions', 'panel-right', () => setDrawerOpen(open => !open), 'outline backlinks پنل صفحه'),
      )
      for (const item of pageActions.organizeItems(current)) {
        if ('onSelect' in item && item.onSelect) {
          list.push({ id: item.testid ?? item.label, label: item.label, group: 'Page actions', icon: item.icon, keywords: item.label + ' page صفحه', run: item.onSelect })
        }
      }
    }
    const editor = document.querySelector<HTMLElement & { editor?: Editor }>('.main :is([data-testid="editor"], [data-testid="row-editor"]) .ProseMirror')?.editor
    if (editor?.isEditable && !reader) {
      if (onPage) list.push(entry('find-page', 'Find in page', 'Page actions', 'search', () => window.dispatchEvent(new Event('open-find')), 'find search ctrl+f جستجو', bindingHint('find')))
      for (const { item, title, desc, searchOnly } of editorSearchItems()) list.push({
        id: 'editor-' + item.title + (item.vars?.name ?? ''), label: title, group: 'Writing', searchOnly,
        icon: <Icon name="pencil" size={16} />, keywords: [item.title, item.keywords, desc].join(' '),
        run: () => runEditorCommand(editor, item),
      })
    }
    return list
  }

  return (
    <div data-preferences={route.name === 'settings' ? '' : undefined} className={'app' + (reader && onPage ? ' reading' : '')} style={{ '--page-w': pageW + 'px', '--r-scale': readerCfg.scale } as React.CSSProperties}>
      <Rail
        route={route} status={status} dueCards={dueCards} trashCount={ws.tree.trash.length} iconsOnly={iconsOnly} narrow={narrow}
        width={railW} defaultWidth={settings.sidebar === 'compact' ? 168 : 192} onWidth={setRailW}
        onGo={goTo} onSearch={onSearch} searchHint={isMac ? '⌘K' : 'Ctrl K'}
        onNewPage={() => onNewPage('')} onNewDatabase={onNewDatabase} onNewTodo={newTodo}
        onNewBoard={onNewBoard}
        onNewFolder={() => pageActions.newFolder()}
        onOpenSettings={() => { go({ name: 'settings', tab: 'sync' }); setDrawer(false) }} onSignOut={onSignOut} workspaceName={workspaceName ?? ''} onWorkspaces={onWorkspaces ?? (() => undefined)}
      />
      {!overlay && <ContextPanel
        title={t(PANEL_TITLES[route.name] ?? 'Pages')} kind={panelKind} open={panelOpen} narrow={narrow} width={sideW} onWidth={setSideW} onClose={() => setDrawer(false)} setHost={setHost}
        pages={pages} index={index} currentId={currentId} rowProps={rowProps} settings={settings} onSettings={updateSettings}
        savedSearches={ws.data.savedSearches.filter(search => !search.trashed)}
        onSavedSearch={query => { setSearchInit(query); onSearch() }}
        onDeleteSavedSearch={id => { void ws.mutate([id], c => updateSavedSearch(c, id, { trashed: true })).catch(() => ws.notify(t('Could not complete the action. Please try again.'))) }}
        onReveal={revealCurrent}
        tools={route.name === 'tasks' ? <IconButton label={t('New list')} onClick={() => void ws.newTodoList(t('New list')).then(id => go({ name: 'page', id }))}><Icon name="plus" size={15} /></IconButton> : undefined}
        onOpen={open} onExpandAll={() => setCollapsed(new Set())} onCollapseAll={() => setCollapsed(new Set(boxes()))} treeFrame={treeFrame}
      />}
      <main className={'main' + (drawerOpen && !reader && onPage ? ' drawer-open' : '')}>
        <Topbar
          narrow={narrow} mobileItems={[
            ...(onPage && current ? [
              { label: t('Reader mode'), icon: <Icon name="book" size={16} />, onSelect: () => setReader(true) },
              { label: t('Page side panel (quick actions & navigation)'), icon: <Icon name="panel-right" size={16} />, onSelect: () => setDrawerOpen(o => !o) },
              { label: t(current.favorite ? 'Remove from favorites' : 'Add to favorites'), icon: <Icon name="star" size={16} />, onSelect: () => void ws.setMeta(current.id, { favorite: !current.favorite }) },
              ...pageActions.shareItems(current.id),
            ] : []),
            { label: t(dark ? 'Light mode' : 'Dark mode'), icon: <Icon name={dark ? 'sun' : 'moon'} size={16} />, onSelect: () => updateSettings({ theme: dark ? 'light' : 'dark' }) },
          ]}
          noPanel={overlay} routeName={route.name} crumbs={crumbs} current={current} panelOpen={panelOpen} onTogglePanel={togglePanel} onHome={() => goTo('home')} onOpen={open} onMenu={rowProps.onMenu} nav={nav}
          save={status && status.unsaved > 0 ? 'saving' : save} dark={dark} onToggleDark={() => updateSettings({ theme: dark ? 'light' : 'dark' })}
          fullScreen={fullScreen} onToggleFullScreen={toggleFullScreen} onFavorite={id => void ws.setMeta(id, { favorite: !byId.get(id)?.favorite })}
          shareItems={currentId ? pageActions.shareItems(currentId) : undefined} onHistory={undefined}
          pageTools={<>
            {!narrow && <IconButton label={t('Reader mode') + '  ' + bindingHint('reader')} onClick={() => setReader(true)}><Icon name="book" size={17} /></IconButton>}
            {!narrow && <IconButton label={t('Page side panel (quick actions & navigation)')} data-testid="page-panel-toggle" pressed={drawerOpen} onClick={() => setDrawerOpen(o => !o)}><Icon name="panel-right" size={17} /></IconButton>}
            {pageTools}
          </>}
        />
        {reader && onPage && <ReaderBar cfg={readerCfg} onCfg={c => { setReaderCfg(c); try { localStorage.setItem('nevis.reader.cfg', JSON.stringify(c)) } catch { /* private window */ } }} width={pageW} onWidth={savePageW} onExit={() => setReader(false)} />}
        <div className="scroller"><PageChrome.Provider value={{ reader: reader && onPage }}><PanelHost.Provider value={panelKind === 'host' ? host : null}><PageContextMenu.Provider value={rowProps.onMenu}>{children}</PageContextMenu.Provider></PanelHost.Provider></PageChrome.Provider></div>
        {onPage && current && (
          <PagePanel
            open={drawerOpen && !reader} page={current} pages={pages} onClose={() => setDrawerOpen(false)} onOpen={open} onNewSub={() => onNewPage(current.id)}
            onCover={rect => window.dispatchEvent(new CustomEvent('nevis:page-cover', { detail: rect }))}
            onExport={() => void ws.markdownOf(current.id).then(m => download(new TextEncoder().encode(m.text), m.path.split('/').pop() || 'page.md', 'text/markdown'))}
          />
        )}
      </main>
      {rowMenu && <Menu anchor={rowMenu.rect} align="end" onClose={() => setRowMenu(null)} items={rowItems(rowMenu.id)} />}
      {pageActions.dialogs}
      {searchOpen && <Palette ws={ws} commands={paletteCommands()} initialQuery={searchInit} onClose={() => { setSearchInit(''); onCloseSearch() }} onOpen={open} />}
    </div>
  )
}
