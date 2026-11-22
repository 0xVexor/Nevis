// The top bar of the main column (`header.topbar`): panel toggle, back/forward, the breadcrumb path, then the save state and the tools,
// as the old app laid them out. What a page offers (favorite, share, reader) appears only on a page.
import { useState, type ReactNode } from 'react'
import { Button, Icon, IconButton, Menu, SaveStatus, type MenuItem } from '../ds'
import { t } from '../i18n'
import type { Route } from '../router'
import type { Page } from './model'
import { commandHint } from '../shortcutCommands'
import { iconNode } from '../ds/iconSet'

type Name = Route['name']
const CRUMB: Partial<Record<Name, { label: string; icon?: string }>> = {
  home: { label: 'Home' }, templates: { label: 'Templates', icon: 'templates' }, tasks: { label: 'Tasks', icon: 'tasks' }, cards: { label: 'Flashcards', icon: 'cards' },
  graph: { label: 'Graph', icon: 'graph' }, all: { label: 'All pages', icon: 'table' }, settings: { label: 'Settings', icon: 'settings' }, trash: { label: 'Trash', icon: 'trash' },
  databases: { label: 'Databases', icon: 'table' }, drawings: { label: 'Drawings', icon: 'pencil' }, files: { label: 'Files', icon: 'folder' },
}

export interface TopbarProps {
  /** the screen fills the window: there is no side panel to toggle */
  noPanel?: boolean
  routeName: Name
  crumbs: Page[]
  current: Page | null
  panelOpen: boolean
  onTogglePanel: () => void
  onHome: () => void
  onOpen: (id: string) => void
  nav: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void }
  save: 'idle' | 'saving' | 'saved' | 'error'
  dark: boolean
  onToggleDark: () => void
  fullScreen: boolean
  onToggleFullScreen: () => void
  onFavorite?: (id: string) => void
  shareItems?: MenuItem[]
  /** extra buttons for a page (reader mode, the page side panel) */
  pageTools?: ReactNode
  onHistory?: () => void
}

export function Topbar(p: TopbarProps) {
  const [menu, setMenu] = useState<{ rect: DOMRect; items: MenuItem[] } | null>(null)
  const onPage = p.routeName === 'page' && !!p.current && p.current.kind !== 'folder'
  const shown = p.crumbs.length > 3 ? [p.crumbs[0]!, null, ...p.crumbs.slice(-2)] : p.crumbs // a deep page keeps the top level and its last two ancestors
  const here = CRUMB[p.routeName]
  return (
    <header className="topbar">
      {!p.noPanel && <IconButton label={(p.panelOpen ? t('Hide side panel') : t('Show side panel')) + '  ' + commandHint('Open or close the sidebar')} data-testid="panel-toggle" aria-expanded={p.panelOpen} aria-controls="workspace-context" onClick={p.onTogglePanel}><Icon name="panel-left" size={17} className="ds-flip" /></IconButton>}
      <div className="nav-hist">
        <IconButton label={t('Back  Alt+←')} disabled={!p.nav.canBack} onClick={p.nav.back}><Icon name="arrow-left" size={17} className="ds-flip" /></IconButton>
        <IconButton label={t('Forward  Alt+→')} disabled={!p.nav.canForward} onClick={p.nav.forward}><Icon name="arrow-right" size={17} className="ds-flip" /></IconButton>
      </div>
      <nav className="crumbs">
        <IconButton className="crumb-home" label={t('Home')} onClick={p.onHome}><Icon name="home" size={15} /></IconButton>
        {here && <span className="crumb"><span className="crumb-cur">{here.icon && <Icon name={here.icon} size={14} />}{t(here.label)}</span></span>}
        {p.routeName === 'page' && shown.map((c, i) => c === null ? (
          <span key="more" className="crumb crumb-more">
            <span className="crumb-sep"><Icon name="chevron-right" size={13} /></span>
            <button type="button" aria-haspopup="menu" aria-label={t('{n} more pages', { n: p.crumbs.length - 3 })} title={t('{n} more pages', { n: p.crumbs.length - 3 })}
              onClick={e => setMenu({ rect: e.currentTarget.getBoundingClientRect(), items: p.crumbs.slice(1, -2).map(x => ({ label: x.title || t(x.kind === 'folder' ? 'Folder' : 'Untitled'), raw: !!x.title, icon: x.kind === 'folder' ? <Icon name="folder" /> : iconNode(x.icon, 16, <Icon name="file" />), onSelect: () => x.kind !== 'folder' && p.onOpen(x.id) })) })}>…</button>
          </span>
        ) : (
          <span key={c.id} className={'crumb' + (i === shown.length - 1 ? ' last' : '')}>
            <span className="crumb-sep"><Icon name="chevron-right" size={13} /></span>
            {c.kind === 'folder'
              ? <span className="crumb-folder" dir="auto" title={c.title || t('Folder')}><Icon name="folder" size={14} /><span>{c.title || t('Folder')}</span></span>
              : <button onClick={() => p.onOpen(c.id)} dir="auto" title={c.title || t('Untitled')}><span className="ic">{iconNode(c.icon, 14)}</span><span className="crumb-t">{c.title || t('Untitled')}</span></button>}
          </span>
        ))}
      </nav>
      {menu && <Menu anchor={menu.rect} onClose={() => setMenu(null)} items={menu.items} />}
      <span className="spacer" />
      {onPage && <SaveStatus state={p.save} label={p.save === 'saving' ? t('Saving…') : p.save === 'error' ? t('Could not save. Your changes are still here.') : t('All changes saved')} />}
      <div className="tb-group">
        {onPage && p.onHistory && <IconButton label={t('Version history')} data-testid="open-history" onClick={p.onHistory}><Icon name="history" size={17} /></IconButton>}
        {onPage && p.pageTools}
        <IconButton label={(p.fullScreen ? t('Exit full screen') : t('Full screen')) + '  ' + commandHint('Full screen')} pressed={p.fullScreen} className="ds-icon-btn--toggle topbar-fullscreen" onClick={p.onToggleFullScreen}><Icon name={p.fullScreen ? 'minimize' : 'maximize'} size={17} /></IconButton>
        <IconButton label={p.dark ? t('Light mode') : t('Dark mode')} onClick={p.onToggleDark}><Icon name={p.dark ? 'sun' : 'moon'} size={17} /></IconButton>
      </div>
      {onPage && p.current && p.onFavorite && (
        <IconButton className="ds-icon-btn--toggle" pressed={!!p.current.favorite} label={p.current.favorite ? t('Remove from favorites') : t('Add to favorites')} onClick={() => p.onFavorite!(p.current!.id)}><Icon name="star" size={18} /></IconButton>
      )}
      {onPage && p.shareItems && (
        <Button variant="primary" size="sm" className="share-btn" title={t('Share & export')} icon={<Icon name="share" size={16} />} aria-haspopup="menu" onClick={e => setMenu({ rect: e.currentTarget.getBoundingClientRect(), items: p.shareItems! })}>
          <span className="share-btn-label">{t('Share')}</span>
        </Button>
      )}
    </header>
  )
}
