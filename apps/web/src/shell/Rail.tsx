// The navigation rail (`nav.side`): the old app's markup and classes. An icon column by default; the logo pins it open into a labelled column.
import { useState } from 'react'
import { Button, Icon, Menu, WorkspaceHeader } from '../ds'
import { ResizeHandle } from '../ds/ResizeHandle'
import { t } from '../i18n'
import type { Route } from '../router'
import type { WsStatus } from '../workspace'
import { Brand } from './Brand'
import { BrandMark } from './BrandMark'
import { SideTip } from './SideTip'
import { SyncIndicator } from './SyncIndicator'

export const RAIL_MIN = 148
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
  onNewAllBlocks: () => void
  onNewTodo: () => void
  onOpenSettings: () => void
  onSignOut?: () => void
  workspaceName: string
  onWorkspaces: () => void
}

export function Rail(p: RailProps) {
  const [pinned, setPinned] = useState(false) // the icon column opened from the logo
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null)
  const expanded = p.iconsOnly && pinned
  const labelled = !p.iconsOnly || expanded
  const row = (e: Entry) => {
    const count = e.badge === 'cards' ? p.dueCards : e.badge === 'trash' ? p.trashCount : 0
    return (
      <button key={e.route} aria-label={t(e.label)} data-testid={e.testid} className={'row plain' + (p.route.name === e.route ? ' cur' : '')} onClick={() => p.onGo(e.route)}>
        <span className="ic"><Icon name={e.icon} /></span>
        <span className="ntitle">{t(e.label)}</span>
        {count > 0 && <span className="ds-badge">{count}</span>}
      </button>
    )
  }
  return (
    <nav
      className="side"
      aria-label={t('Workspace navigation')}
      data-rail={p.iconsOnly ? '' : undefined}
      data-icons={p.iconsOnly && !expanded ? '' : undefined}
      data-expanded={expanded ? '' : undefined}
      style={p.width ? ({ '--nav-user-width': p.width + 'px' } as React.CSSProperties) : undefined}
    >
      {!p.narrow && labelled && <ResizeHandle label={t('Resize navigation rail')} width={p.width ?? p.defaultWidth} min={RAIL_MIN} max={RAIL_MAX} onResize={p.onWidth} />}
      <div className="ws">
        <WorkspaceHeader
          mark={<BrandMark />} name={<Brand />} revealLabel={t(pinned ? 'Unpin sidebar' : 'Pin sidebar')} expanded={labelled}
          pressed={p.iconsOnly ? pinned : undefined} onActivate={p.iconsOnly ? () => setPinned(v => !v) : undefined}
        />
      </div>
      <div className="side-scroll">
        <button aria-label={t('Search')} className="row plain search-row" data-testid="open-palette" onClick={p.onSearch}>
          <span className="ic"><Icon name="search" /></span><span className="ntitle">{t('Search')}...</span><kbd dir="ltr">{p.searchHint}</kbd>
        </button>
        {MAIN.map(row)}
      </div>
      <SideTip />
      <div className="side-foot">
        <SyncIndicator status={p.status} onOpenSettings={p.onOpenSettings} />
        {FOOT.map(row)}
        <Button variant="primary" className="side-new" aria-label={t('New')} aria-haspopup="menu" aria-expanded={!!newMenu} data-testid="new-menu" onClick={e => setNewMenu(newMenu ? null : e.currentTarget.getBoundingClientRect())}>
          <Icon name="plus" size={16} /><span className="ntitle">{t('New')}</span>
        </Button>
        {newMenu && (
          <Menu anchor={newMenu} onClose={() => setNewMenu(null)} items={[
            { label: t('New page'), testid: 'new-page', icon: <Icon name="file" size={16} />, onSelect: p.onNewPage },
            { label: t('New database'), testid: 'new-database', icon: <Icon name="table" size={16} />, onSelect: p.onNewDatabase },
            { label: t('New to-do list'), testid: 'new-todo', icon: <Icon name="checklist" size={16} />, onSelect: p.onNewTodo },
            { label: t('All blocks sample'), testid: 'new-all-blocks', icon: <Icon name="blocks" size={16} />, onSelect: p.onNewAllBlocks },
          ]} />
        )}
        <div className="side-workspace">
          <button className="wscard" title={t('Workspaces')} data-testid="workspaces" onClick={p.onWorkspaces}>
            <span className="wscard-ic"><Icon name="vault" /></span>
            <span className="wscard-tx"><b dir="auto">{p.workspaceName || t('Personal space')}</b><small>{t('Synced workspace')}</small></span>
            <span className="wscard-chev"><Icon name="chevrons-up-down" size={14} /></span>
          </button>
        </div>
        {p.onSignOut && <button aria-label={t('Sign out')} data-testid="signout" className="row plain" onClick={p.onSignOut}><span className="ic"><Icon name="log-out" /></span><span className="ntitle">{t('Sign out')}</span></button>}
        <div className="side-credit">{t('Created by')} Vexor</div>
      </div>
    </nav>
  )
}
