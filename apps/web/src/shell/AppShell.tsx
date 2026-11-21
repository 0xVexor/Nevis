// The frame of the app, as the old app drew it: an icon rail (`nav.side`), the Pages panel (`aside.context-panel`) with the page tree,
// and the main column (`header.topbar` + `.scroller`). Markup and class names are the old ones, so the copied stylesheets (ds/areas) apply
// as they did there; only the data comes from the new layer (shell/adapt.ts).
import { useMemo, useState, type ReactNode } from 'react'
import { Button, Icon, IconButton, Menu, SaveStatus, WorkspaceHeader, type MenuItem } from '../ds'
import { t } from '../i18n'
import { go, type Route } from '../router'
import { setDeviceSettings, useDeviceSettings } from '../deviceSettings'
import type { Workspace, WsStatus } from '../workspace'
import { legacyPages } from './adapt'
import { Brand } from './Brand'
import { BrandMark } from './BrandMark'
import { HorizontalScroll } from './HorizontalScroll'
import { buildIndex } from './pageIndex'
import { TreeFrame, TreeRow } from './PageTree'

const ROOT_CAP = 200

interface RailItem { id: string; label: string; icon: string; route: Route['name']; testid: string }
const RAIL: RailItem[] = [
  { id: 'home', label: 'Home', icon: 'home', route: 'home', testid: 'nav-home' },
  { id: 'templates', label: 'Templates', icon: 'templates', route: 'templates', testid: 'nav-templates' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', route: 'tasks', testid: 'nav-tasks' },
  { id: 'graph', label: 'Graph', icon: 'graph', route: 'graph', testid: 'nav-graph' },
  { id: 'all', label: 'All pages', icon: 'table', route: 'all', testid: 'nav-all' },
]

export interface ShellProps {
  ws: Workspace
  route: Route
  status: WsStatus | null
  children: ReactNode
  onSearch: () => void
  onNewPage: (parent: string) => void
  onNewDatabase: () => void
  onNewAllBlocks: () => void
  onOpen: (id: string) => void
  onSignOut?: () => void
}

export function AppShell({ ws, route, status, children, onSearch, onNewPage, onNewDatabase, onNewAllBlocks, onOpen, onSignOut }: ShellProps) {
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null)
  const [rowMenu, setRowMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [rootCap, setRootCap] = useState(ROOT_CAP)
  const [navOpen, setNavOpen] = useState(false)
  const device = useDeviceSettings()
  const dark = device.theme === 'dark' || (device.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const currentId = route.name === 'page' ? route.id : ''
  const pages = useMemo(() => legacyPages(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => pages.filter(p => !p.deletedAt), [pages])
  const index = useMemo(() => buildIndex(live), [live])
  const roots = (index.kids.get(null) ?? []).slice(0, rootCap)
  const trashCount = ws.tree.trash.length
  const byId = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages])
  const crumbs = useMemo(() => {
    const out = []
    for (let p = byId.get(currentId), n = 0; p && n < 50; p = p.parentId ? byId.get(p.parentId) : undefined, n++) out.unshift(p)
    return out
  }, [byId, currentId])
  const here = (r: Route['name']) => route.name === r
  const open = (id: string) => { onOpen(id); setNavOpen(false) }
  const toggle = (id: string) => setCollapsed(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const rowProps = {
    index, currentId, selectedId: selected, onSelect: setSelected, openOnClick: true, collapsed, onToggle: toggle,
    onOpen: (id: string) => open(id), onAdd: (parent: string) => onNewPage(parent),
    onMenu: (id: string, rect: DOMRect) => setRowMenu({ id, rect }),
    onMove: (id: string, parentId: string | null, beforeId: string | null) => {
      const sibs = ws.children(parentId ?? '').map(n => n.page.id).filter(x => x !== id)
      void ws.moveTo(id, parentId ?? '', beforeId ? Math.max(0, sibs.indexOf(beforeId)) : sibs.length)
    },
  }
  const menuItems = (id: string): MenuItem[] => [
    { label: t('Open'), icon: <Icon name="external-link" size={16} />, onSelect: () => open(id) },
    { label: t('New subpage'), icon: <Icon name="plus" size={16} />, onSelect: () => onNewPage(id) },
    { label: t('Move up'), icon: <Icon name="arrow-up" size={16} />, onSelect: () => void ws.moveUp(id) },
    { label: t('Move down'), icon: <Icon name="arrow-down" size={16} />, onSelect: () => void ws.moveDown(id) },
    { label: t('Indent'), icon: <Icon name="arrow-right" size={16} className="ds-flip" />, onSelect: () => void ws.indent(id) },
    { label: t('Outdent'), icon: <Icon name="arrow-left" size={16} className="ds-flip" />, onSelect: () => void ws.outdent(id) },
    { label: t('Delete'), icon: <Icon name="trash" size={16} />, onSelect: () => { void ws.trash(id); if (id === currentId) go({ name: 'home' }) } },
  ]
  const crumbLabel = (r: Route['name']) => ({ home: 'Home', templates: 'Templates', tasks: 'Tasks', graph: 'Graph', all: 'All pages', settings: 'Settings', trash: 'Trash', page: '' } as Record<string, string>)[r] ?? ''
  const crumbIcon = (r: Route['name']) => ({ templates: 'templates', tasks: 'tasks', graph: 'graph', all: 'table', settings: 'settings', trash: 'trash' } as Record<string, string>)[r]

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')} dir="rtl">
      <nav className="side" aria-label={t('Workspace navigation')} data-rail="" data-icons="">
        <div className="ws"><WorkspaceHeader mark={<BrandMark />} name={<Brand />} revealLabel={t('Expand navigation rail')} expanded={false} /></div>
        <div className="side-scroll">
          <button aria-label={t('Search')} className="row plain search-row" data-testid="open-palette" onClick={onSearch}>
            <span className="ic"><Icon name="search" /></span><span className="ntitle">{t('Search')}...</span><kbd dir="ltr">Ctrl K</kbd>
          </button>
          {RAIL.map(item => (
            <button key={item.id} aria-label={t(item.label)} data-testid={item.testid} className={'row plain' + (here(item.route) ? ' cur' : '')} onClick={() => { go({ name: item.route } as Route); setNavOpen(false) }}>
              <span className="ic"><Icon name={item.icon} /></span><span className="ntitle">{t(item.label)}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <button aria-label={t('Settings')} data-testid="nav-settings" className={'row plain' + (here('settings') ? ' cur' : '')} onClick={() => { go({ name: 'settings' }); setNavOpen(false) }}>
            <span className="ic"><Icon name="settings" /></span><span className="ntitle">{t('Settings')}</span>
          </button>
          <button aria-label={t('Trash')} data-testid="trash-toggle" className={'row plain' + (here('trash') ? ' cur' : '')} onClick={() => { go({ name: 'trash' }); setNavOpen(false) }}>
            <span className="ic"><Icon name="trash" /></span><span className="ntitle">{t('Trash')}</span>
            {trashCount > 0 && <span className="ds-badge">{trashCount}</span>}
          </button>
          <Button variant="primary" className="side-new" aria-label={t('New')} aria-haspopup="menu" aria-expanded={!!newMenu} data-testid="new-menu" onClick={e => setNewMenu(newMenu ? null : e.currentTarget.getBoundingClientRect())}>
            <Icon name="plus" size={16} /><span className="ntitle">{t('New')}</span>
          </Button>
          {newMenu && (
            <Menu anchor={newMenu} onClose={() => setNewMenu(null)} items={[
              { label: t('New page'), testid: 'new-page', icon: <Icon name="file" size={16} />, onSelect: () => onNewPage('') },
              { label: t('New database'), testid: 'new-database', icon: <Icon name="table" size={16} />, onSelect: onNewDatabase },
              { label: t('All blocks sample'), testid: 'new-all-blocks', icon: <Icon name="blocks" size={16} />, onSelect: onNewAllBlocks },
            ]} />
          )}
          {onSignOut && <button aria-label={t('Sign out')} data-testid="signout" className="row plain" onClick={onSignOut}><span className="ic"><Icon name="log-out" /></span><span className="ntitle">{t('Sign out')}</span></button>}
        </div>
      </nav>

      <aside id="workspace-context" className="context-panel" aria-label={t('Pages')}>
        <header className="context-heading">
          <h2>{t('Pages')}</h2>
          <div className="context-tools" role="group" aria-label={t('Panel tools')}>
            <IconButton label={t('Expand all')} onClick={() => setCollapsed(new Set())}><Icon name="chevrons-up-down" size={15} /></IconButton>
            <IconButton label={t('Collapse all')} onClick={() => setCollapsed(new Set(live.filter(p => (index.kids.get(p.id) ?? []).length > 0).map(p => p.id)))}><Icon name="chevrons-down-up" size={15} /></IconButton>
          </div>
        </header>
        <div className="side-scroll">
          <div className="side-collections">
            <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom>
              <TreeFrame
                label={t('Pages')} selectedId={selected} onSelect={setSelected} onOpen={id => open(id)} onToggle={toggle} onMenu={rowProps.onMenu}
                isOpenBox={id => { const k = index.kids.get(id) ?? []; return k.length ? !collapsed.has(id) : null }}
                parentOf={id => byId.get(id)?.parentId ?? null}
              >
                <div data-testid="tree">{roots.map(p => <TreeRow key={p.id} {...rowProps} page={p} depth={0} />)}</div>
              </TreeFrame>
            </HorizontalScroll>
            {(index.kids.get(null) ?? []).length > rootCap && <button className="section" data-testid="tree-more" onClick={() => setRootCap(c => c + ROOT_CAP)}>{t('Show more')} ({(index.kids.get(null) ?? []).length - rootCap})</button>}
            {roots.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <IconButton label={t('Menu')} className="nav-toggle" onClick={() => setNavOpen(o => !o)}><Icon name="list" /></IconButton>
          <nav className="crumbs">
            <IconButton className="crumb-home" label={t('Home')} onClick={() => go({ name: 'home' })}><Icon name="home" size={15} /></IconButton>
            {route.name !== 'page' && route.name !== 'home' && (
              <span className="crumb"><span className="crumb-cur">{crumbIcon(route.name) && <Icon name={crumbIcon(route.name)!} size={14} />}{t(crumbLabel(route.name))}</span></span>
            )}
            {route.name === 'home' && <span className="crumb"><span className="crumb-cur">{t('Home')}</span></span>}
            {route.name === 'page' && crumbs.map((c, i) => (
              <span key={c.id} className={'crumb' + (i === crumbs.length - 1 ? ' last' : '')}>
                <span className="crumb-sep"><Icon name="chevron-right" size={13} /></span>
                <button onClick={() => open(c.id)} dir="auto" title={c.title || t('Untitled')}><span className="crumb-t">{c.title || t('Untitled')}</span></button>
              </span>
            ))}
          </nav>
          <span className="spacer" />
          {status && <span data-testid="net" data-online={status.online} className="sync-chip">{status.online ? `● ${t('Online')}` : `○ ${t('Offline')}`}</span>}
          {status && <span className="sync-chip">{t('Not sent yet')}: <b data-testid="outbox">{status.outbox}</b>{status.unsaved > 0 ? ` (+${status.unsaved})` : ''}</span>}
          {status && status.files.pending > 0 && <span className="sync-chip" data-testid="files">{`${t('Files')}: ${status.files.pending}`}{status.files.uploading && status.files.total ? ` (${Math.round(100 * status.files.sent / status.files.total)}٪)` : ''}</span>}
          {status?.files.error === 'quota' && <span className="err sync-chip" data-testid="files-quota">فضای حساب شما پر است؛ فایل‌ها روی این دستگاه می‌مانند و چیزی از دست نمی‌رود، اما تا آزاد شدن فضا همگام نمی‌شوند.</span>}
          {status?.files.error === 'blob_too_large' && <span className="err sync-chip" data-testid="files-too-large">فایلی از حد مجاز سرور بزرگ‌تر است و فقط روی این دستگاه می‌ماند.</span>}
          {status?.lastError && <span className="err sync-chip" data-testid="sync-error">{status.lastError}</span>}
          <div className="tb-group">
            <IconButton label={dark ? t('Light mode') : t('Dark mode')} onClick={() => setDeviceSettings({ theme: dark ? 'light' : 'dark' })}><Icon name={dark ? 'sun' : 'moon'} size={17} /></IconButton>
          </div>
        </header>
        <div className="scroller">{children}</div>
      </main>
      {rowMenu && <Menu anchor={rowMenu.rect} align="end" onClose={() => setRowMenu(null)} items={menuItems(rowMenu.id)} />}
    </div>
  )
}
