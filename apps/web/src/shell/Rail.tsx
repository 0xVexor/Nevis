// The navigation rail (`nav.side`): the old app's markup and classes. An icon column by default; the logo pins it open into a labelled column.
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Menu, WorkspaceHeader, useMenu } from '../ds'
import { ResizeHandle } from '../ds/ResizeHandle'
import { t } from '../i18n'
import type { Route } from '../router'
import type { WsStatus } from '../workspace'
import { Brand } from './Brand'
import { BrandMark } from './BrandMark'
import { SideTip } from './SideTip'
import { SyncIndicator } from './SyncIndicator'

export const RAIL_MIN = 168
export const RAIL_MAX = 320

type Name = Route['name']
interface Entry { route: Name; label: string; icon: string; testid: string; badge?: 'cards' | 'trash' }
const MAIN: Entry[] = [
  { route: 'home', label: 'Home', icon: 'home', testid: 'nav-home' },
  { route: 'templates', label: 'Templates', icon: 'templates', testid: 'nav-templates' },
  { route: 'tasks', label: 'Tasks', icon: 'tasks', testid: 'nav-tasks' },
  { route: 'cards', label: 'Flashcards', icon: 'cards', testid: 'nav-cards', badge: 'cards' },
  { route: 'databases', label: 'Databases', icon: 'database', testid: 'nav-databases' },
  { route: 'drawings', label: 'Drawings', icon: 'pencil', testid: 'nav-drawings' },
  { route: 'graph', label: 'Graph', icon: 'graph', testid: 'nav-graph' },
  { route: 'all', label: 'All pages', icon: 'table', testid: 'nav-all' },
]
const FOOT: Entry[] = [
  { route: 'settings', label: 'Settings', icon: 'settings', testid: 'nav-settings' },
  { route: 'files', label: 'Files', icon: 'paperclip', testid: 'nav-files' },
  { route: 'trash', label: 'Trash', icon: 'trash', testid: 'trash-toggle', badge: 'trash' },
]

export interface RailProps {
  route: Route
  status: WsStatus | null
  dueCards: number
  trashCount: number
  /** the sidebar style from the device settings: only 'icons' (or a narrow window) draws the icon column */
  iconsOnly: boolean
  narrow: boolean
  width: number | null
  defaultWidth: number
  onWidth: (w: number | null) => void
  onGo: (route: Name) => void
  onSearch: () => void
  searchHint: string
  onNewPage: () => void
  onNewDatabase: () => void
  onNewTodo: () => void
  onNewBoard: () => void
  onNewFolder: () => void
  onOpenSettings: () => void
  onSignOut?: () => void
  workspaceName: string
  onWorkspaces: () => void
}

export function Rail(p: RailProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileMenuButton = useRef<HTMLButtonElement>(null)
  const closeMobile = () => { setMobileOpen(false); requestAnimationFrame(() => mobileMenuButton.current?.focus()) }
  const [pinned, setPinned] = useState(false) // the icon column opened from the logo
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null)
  const workspaceMenu = useMenu()
  const expanded = p.iconsOnly && pinned
  const labelled = !p.iconsOnly || expanded
  const nav = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!expanded) return
    const down = (event: PointerEvent) => {
      const inOverlay = event.composedPath().some(node => node instanceof Element && node.matches('.ds-pop, [role="dialog"]'))
      if (!inOverlay && event.target instanceof Node && !nav.current?.contains(event.target)) setPinned(false)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [expanded])
  useEffect(() => {
    if (!mobileOpen) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMobile() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [mobileOpen])
  const row = (e: Entry) => {
    const count = e.badge === 'cards' ? p.dueCards : e.badge === 'trash' ? p.trashCount : 0
    return (
      <button key={e.route} aria-label={t(e.label)} aria-description={count > 0 ? String(count) : undefined} data-testid={e.testid} title={count > 0 ? `${t(e.label)} (${count})` : t(e.label)} className={'row plain' + (p.route.name === e.route ? ' cur' : '')} onClick={() => { p.onGo(e.route); setMobileOpen(false) }}>
        <span className="ic"><Icon name={e.icon} /></span>
        <span className="ntitle">{t(e.label)}</span>
        {count > 0 && <span className="ds-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
      </button>
    )
  }
  return (
    <>
    {p.narrow && mobileOpen && <button className="mobile-nav-backdrop" aria-label={t('Close')} onClick={closeMobile} />}
    <nav
      ref={nav}
      className={'side' + (p.narrow ? ' mobile-drawer' : '')}
      id={p.narrow ? 'mobile-workspace-menu' : undefined}
      hidden={p.narrow && !mobileOpen}
      aria-label={t('Workspace navigation')}
      data-rail={p.iconsOnly ? '' : undefined}
      data-icons={p.iconsOnly && !expanded ? '' : undefined}
      data-expanded={expanded ? '' : undefined}
      style={p.width ? ({ '--nav-user-width': p.width + 'px' } as React.CSSProperties) : undefined}
    >
      {!p.narrow && labelled && <ResizeHandle label={t('Resize navigation rail')} width={p.width ?? p.defaultWidth} min={RAIL_MIN} max={RAIL_MAX} onResize={p.onWidth} />}
      <div className="ws">
        {p.narrow && <button className="mobile-drawer-close" aria-label={t('Close')} onClick={closeMobile}><Icon name="x" size={20} /></button>}
        <WorkspaceHeader
          mark={<BrandMark />} name={<Brand />} revealLabel={t(pinned ? 'Unpin sidebar' : 'Pin sidebar')} expanded={labelled}
          pressed={p.iconsOnly ? pinned : undefined} onActivate={p.iconsOnly ? () => setPinned(v => !v) : undefined}
        />
      </div>
      <div className="side-content">
      <div className="side-scroll">
        <button aria-label={t('Search')} className="row plain search-row" data-testid="open-palette" onClick={p.onSearch}>
          <span className="ic"><Icon name="search" /></span><span className="ntitle">{t('Search…')}</span><kbd dir="ltr">{p.searchHint}</kbd>
        </button>
        {MAIN.map(row)}
      </div>
      <SideTip />
      <div className="side-foot">
        <SyncIndicator status={p.status} onOpenSettings={p.onOpenSettings} />
        {FOOT.map(row)}
        <Button variant="primary" className="side-new" aria-label={t('New')} aria-haspopup="menu" aria-expanded={!!newMenu} data-testid={p.narrow ? undefined : 'new-menu'} onClick={e => setNewMenu(newMenu ? null : e.currentTarget.getBoundingClientRect())}>
          <Icon name="plus" size={16} /><span className="ntitle">{t('New')}</span>
        </Button>
        <div className="side-workspace">
          <button className="wscard" title={t('Workspaces')} data-testid="workspaces" aria-haspopup="menu" aria-expanded={workspaceMenu.isOpen} onClick={event => workspaceMenu.isOpen ? workspaceMenu.close() : workspaceMenu.open([
            { label: 'Workspaces', icon: <Icon name="vault" size={16} />, onSelect: p.onWorkspaces },
            ...(p.onSignOut ? [{ label: 'Sign out', testid: 'signout', icon: <Icon name="log-out" size={16} />, onSelect: p.onSignOut }] : []),
          ], event.currentTarget)}>
            <span className="wscard-ic"><Icon name="vault" /></span>
            <span className="wscard-tx"><b dir="auto">{p.workspaceName || t('Personal space')}</b><small>{t('Synced workspace')}</small></span>
            <span className="wscard-chev"><Icon name="chevrons-up-down" size={14} /></span>
          </button>
          {workspaceMenu.menu}
        </div>
        <div className="side-credit">{t('Created by')} Vexor</div>
      </div>
      </div>
    </nav>
        {newMenu && (
          <Menu anchor={newMenu} onClose={() => setNewMenu(null)} items={[
            { label: t('New page'), testid: 'new-page', icon: <Icon name="file" size={16} />, onSelect: p.onNewPage },
            { label: t('New folder'), testid: 'new-folder', icon: <Icon name="folder" size={16} />, onSelect: p.onNewFolder },
            { label: t('New board'), testid: 'new-board', icon: <Icon name="pencil" size={16} />, onSelect: p.onNewBoard },
            { label: t('New database'), testid: 'new-database', icon: <Icon name="table" size={16} />, onSelect: p.onNewDatabase },
            { label: t('New to-do list'), testid: 'new-todo', icon: <Icon name="checklist" size={16} />, onSelect: p.onNewTodo },
          ]} />
        )}
    {p.narrow && <nav className="mobile-nav" aria-label={t('Mobile navigation')}>
      <button aria-label={t('Home')} onClick={() => { p.onGo('home'); setMobileOpen(false) }}><Icon name="home" size={20} /><span>{t('Home')}</span></button>
      <button aria-label={t('Search')} onClick={() => { setMobileOpen(false); p.onSearch() }}><Icon name="search" size={20} /><span>{t('Search')}</span></button>
      <button aria-label={t('New')} data-testid="new-menu" aria-haspopup="menu" aria-expanded={!!newMenu} onClick={e => setNewMenu(newMenu ? null : e.currentTarget.getBoundingClientRect())}><Icon name="plus" size={20} /><span>{t('New')}</span></button>
      <button ref={mobileMenuButton} aria-label={t('Menu')} data-testid="mobile-menu" aria-controls="mobile-workspace-menu" aria-expanded={mobileOpen} onClick={() => setMobileOpen(open => !open)}><Icon name="list" size={20} /><span>{t('Menu')}</span></button>
    </nav>}
    </>
  )
}
