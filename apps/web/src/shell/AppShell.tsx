// The frame of the app, composed from the old app's three regions: the rail (nav.side), the side panel (aside.context-panel) and the main
// column (header.topbar + .scroller). Markup and class names are the old ones, so the copied stylesheets (ds/areas) apply as they did there;
// only the data comes from the new layer (shell/adapt.ts). The regions live in Rail.tsx, ContextPanel.tsx and Topbar.tsx.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon, IconButton, Menu, type MenuItem } from '../ds'
import { t } from '../i18n'
import { go, href, type Route } from '../router'
import { isDark, updateSettings, useSettings } from '../deviceSettings'
import { download } from '../download'
import type { Workspace, WsStatus } from '../workspace'
import { legacyPages } from './adapt'
import { bindingHint, matches } from '../shortcutBindings'
import { ContextPanel } from './ContextPanel'
import { PageChrome } from './pageChrome'
import { PagePanel } from './PagePanel'
import { ReaderBar, loadReaderCfg, type ReaderCfg } from './ReaderBar'
import { buildIndex } from './pageIndex'
import { PanelHost } from './panelHost'
import { Rail } from './Rail'
import { Topbar } from './Topbar'
import { useNavHistory } from './useNavHistory'

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
  onNewPage: (parent: string) => void
  onNewDatabase: () => void
  onNewAllBlocks: () => void
  onNewFolder?: () => void
  onNewTodo?: () => void
  onOpen: (id: string) => void
  onSignOut?: () => void
  /** back to the list of workspaces */
  onWorkspaces?: () => void
  /** the page's history (the clock in the top bar) */
  onHistory?: () => void
  /** flashcards due now (the badge on the rail) */
  dueCards?: number
  /** a page's own tools in the top bar (reader mode, the page side panel) */
  pageTools?: ReactNode
  save?: 'idle' | 'saving' | 'saved' | 'error'
}

export function AppShell({ ws, route, status, children, onSearch, onNewPage, onNewDatabase, onNewAllBlocks, onNewFolder, onNewTodo, onOpen, onSignOut, onWorkspaces, onHistory, dueCards = 0, pageTools, save = 'saved' }: ShellProps) {
  const settings = useSettings()
  const [rowMenu, setRowMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [railW, setRailW] = useStoredNumber('nevis.railW', 148, 320)
  const [sideW, setSideW] = useStoredNumber('nevis.sideW', 240, 600)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [wide, setWide] = useState(true)
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
  const togglePanel = () => (narrow ? setDrawer(o => !o) : setWide(o => !o))
  const dark = isDark(settings)
  const currentId = route.name === 'page' ? route.id : ''
  const pages = useMemo(() => legacyPages(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => pages.filter(p => !p.deletedAt), [pages])
  const index = useMemo(() => buildIndex(live), [live])
  const byId = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages])
  const current = byId.get(currentId) ?? null
  const crumbs = useMemo(() => {
    const out = []
    for (let p = byId.get(currentId), n = 0; p && n < 50; p = p.parentId ? byId.get(p.parentId) : undefined, n++) out.unshift(p)
    return out
  }, [byId, currentId])
  const nav = useNavHistory(href(route), useCallback((h: string) => { location.hash = h }, []))
  const open = (id: string) => { onOpen(id); setDrawer(false) }
  const goTo = (name: Route['name']) => { go({ name } as Route); setDrawer(false) }
  const toggle = (id: string) => setCollapsed(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const boxes = () => live.filter(p => (index.kids.get(p.id) ?? []).length > 0 || p.kind === 'folder').map(p => p.id)

  const rowProps = {
    index, currentId, selectedId: selected, onSelect: setSelected, openOnClick: settings.treeSingleClick, collapsed, onToggle: toggle,
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
    { label: t('Open'), icon: <Icon name="external-link" size={16} />, onSelect: () => open(id) },
    { label: t('New subpage'), testid: 'menu-subpage', icon: <Icon name="plus" size={16} />, onSelect: () => onNewPage(id) },
    { label: byId.get(id)?.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: <Icon name="star" size={16} />, onSelect: () => void ws.setMeta(id, { favorite: !byId.get(id)?.favorite }) },
    { label: t('Move up'), icon: <Icon name="arrow-up" size={16} />, onSelect: () => void ws.moveUp(id) },
    { label: t('Move down'), icon: <Icon name="arrow-down" size={16} />, onSelect: () => void ws.moveDown(id) },
    { label: t('Indent'), icon: <Icon name="arrow-right" size={16} className="ds-flip" />, onSelect: () => void ws.indent(id) },
    { label: t('Outdent'), icon: <Icon name="arrow-left" size={16} className="ds-flip" />, onSelect: () => void ws.outdent(id) },
    { label: t('Delete'), testid: 'menu-delete', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => { void ws.trash(id); if (id === currentId) go({ name: 'home' }) } },
  ]
  const shareItems = (id: string): MenuItem[] => [
    { label: t('Export as Markdown'), icon: <Icon name="download" size={16} />, onSelect: () => void ws.markdownOf(id).then(m => download(new TextEncoder().encode(m.text), m.path.split('/').pop() || 'page.md', 'text/markdown')) },
    { label: t('Print'), icon: <Icon name="printer" size={16} />, onSelect: () => window.print() },
    { label: t('Copy link'), icon: <Icon name="link" size={16} />, onSelect: () => void navigator.clipboard?.writeText(location.origin + location.pathname + href({ name: 'page', id })) },
  ]
  const panelKind = route.name === 'tasks' || route.name === 'settings' ? 'host' : 'vault'
  const toggleFullScreen = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined)
  const iconsOnly = settings.sidebar === 'icons' || narrow
  const onPage = route.name === 'page' && !!current
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const wider = matches(e, 'widerColumn')
      if (wider || matches(e, 'narrowerColumn')) { e.preventDefault(); savePageW(Math.min(PAGE_W.max, Math.max(PAGE_W.min, pageW + (wider ? PAGE_W.step : -PAGE_W.step)))) }
      if (matches(e, 'reader')) { e.preventDefault(); setReader(r => !r) }
      if (matches(e, 'sidebar')) { e.preventDefault(); togglePanel() }
      if (e.key === 'Escape' && reader && !document.querySelector('.lightbox, .palette-overlay, .ds-pop')) setReader(false)
    }
    const toggleReader = () => setReader(r => !r)
    const history = () => onHistory?.()
    window.addEventListener('keydown', key); window.addEventListener('toggle-reader', toggleReader); window.addEventListener('open-history', history)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('toggle-reader', toggleReader); window.removeEventListener('open-history', history) }
  }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!onPage) setReader(false) }, [onPage])

  return (
    <div data-preferences={route.name === 'settings' ? '' : undefined} className={'app' + (reader && onPage ? ' reading' : '')} style={{ '--page-w': pageW + 'px', '--r-scale': readerCfg.scale } as React.CSSProperties}>
      <Rail
        route={route} status={status} dueCards={dueCards} trashCount={ws.tree.trash.length} iconsOnly={iconsOnly} narrow={narrow}
        width={railW} defaultWidth={settings.sidebar === 'compact' ? 148 : 176} onWidth={setRailW}
        onGo={goTo} onSearch={onSearch} searchHint={isMac ? '⌘K' : 'Ctrl K'}
        onNewPage={() => onNewPage('')} onNewDatabase={onNewDatabase} onNewAllBlocks={onNewAllBlocks} onNewFolder={onNewFolder ?? (() => onNewPage(''))} onNewTodo={onNewTodo ?? (() => onNewPage(''))}
        onOpenSettings={() => goTo('settings')} onSignOut={onSignOut} workspaceName="" onWorkspaces={onWorkspaces ?? (() => undefined)}
      />
      <ContextPanel
        title={t(PANEL_TITLES[route.name] ?? 'Pages')} kind={panelKind} open={panelOpen} narrow={narrow} width={sideW} onWidth={setSideW} onClose={() => setDrawer(false)} setHost={setHost}
        pages={pages} index={index} currentId={currentId} rowProps={rowProps} settings={settings} onSettings={updateSettings}
        onReveal={() => { if (currentId) { setSelected(currentId); setCollapsed(c => { const n = new Set(c); for (let p = byId.get(currentId); p; p = p.parentId ? byId.get(p.parentId) : undefined) n.delete(p.id); return n }) } }}
        onOpen={open} onExpandAll={() => setCollapsed(new Set())} onCollapseAll={() => setCollapsed(new Set(boxes()))} treeFrame={treeFrame}
      />
      <main className={'main' + (drawerOpen && !reader && onPage ? ' drawer-open' : '')}>
        <Topbar
          routeName={route.name} crumbs={crumbs} current={current} panelOpen={panelOpen} onTogglePanel={togglePanel} onHome={() => goTo('home')} onOpen={open} nav={nav}
          save={status && status.unsaved > 0 ? 'saving' : save} dark={dark} onToggleDark={() => updateSettings({ theme: dark ? 'light' : 'dark' })}
          fullScreen={fullScreen} onToggleFullScreen={toggleFullScreen} onFavorite={id => void ws.setMeta(id, { favorite: !byId.get(id)?.favorite })}
          shareItems={currentId ? shareItems(currentId) : undefined} onHistory={undefined}
          pageTools={<>
            <IconButton label={t('Reader mode') + '  ' + bindingHint('reader')} onClick={() => setReader(true)}><Icon name="book" size={17} /></IconButton>
            <IconButton label={t('Page side panel (quick actions & navigation)')} data-testid="page-panel-toggle" pressed={drawerOpen} onClick={() => setDrawerOpen(o => !o)}><Icon name="panel-right" size={17} /></IconButton>
            {pageTools}
          </>}
        />
        {reader && onPage && <ReaderBar cfg={readerCfg} onCfg={c => { setReaderCfg(c); try { localStorage.setItem('nevis.reader.cfg', JSON.stringify(c)) } catch { /* private window */ } }} width={pageW} onWidth={savePageW} onExit={() => setReader(false)} />}
        <div className="scroller"><PageChrome.Provider value={{ reader: reader && onPage }}><PanelHost.Provider value={panelKind === 'host' ? host : null}>{children}</PanelHost.Provider></PageChrome.Provider></div>
        {onPage && current && (
          <PagePanel
            open={drawerOpen && !reader} page={current} pages={pages} onClose={() => setDrawerOpen(false)} onOpen={open} onNewSub={() => onNewPage(current.id)}
            onCover={rect => window.dispatchEvent(new CustomEvent('nevis:page-cover', { detail: rect }))}
            onExport={() => void ws.markdownOf(current.id).then(m => download(new TextEncoder().encode(m.text), m.path.split('/').pop() || 'page.md', 'text/markdown'))}
          />
        )}
      </main>
      {rowMenu && <Menu anchor={rowMenu.rect} align="end" onClose={() => setRowMenu(null)} items={rowItems(rowMenu.id)} />}
    </div>
  )
}
