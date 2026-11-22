// The side panel (`aside.context-panel`): the page tree with Favorites above it and the tag browser below, as the old app drew it.
// Tasks and Settings put their own navigation into the same panel through `PanelHost` (the `side-scroll` element is the host).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon, IconButton, Menu, dirOf, type MenuItem } from '../ds'
import { ResizeHandle } from '../ds/ResizeHandle'
import { commandHint } from '../shortcutCommands'
import { t } from '../i18n'
import type { Settings } from '../deviceSettings'
import { HorizontalScroll } from './HorizontalScroll'
import type { Page } from './model'
import type { PageIndex } from './pageIndex'
import { PageIcon } from './PageIcon'
import { CompactList, TreeFrame, TreeRow, type RowProps } from './PageTree'
import { SidebarTags, type TagInfo } from './SidebarTags'

export const SIDE_MIN = 240
export const SIDE_MAX = 600
const ROOT_CAP = 200
type Shut = { favs?: boolean; pages?: boolean; tags?: boolean }

export interface ContextPanelProps {
  title: string
  /** 'vault' draws the page tree; 'host' panels are filled by their screen through the host element */
  kind: 'vault' | 'host'
  open: boolean
  narrow: boolean
  width: number | null
  onWidth: (w: number | null) => void
  onClose: () => void
  setHost: (el: HTMLElement | null) => void
  pages: Page[]
  index: PageIndex
  currentId: string
  rowProps: Omit<RowProps, 'page' | 'depth'>
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onReveal: () => void
  onOpen: (id: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  treeFrame: Omit<React.ComponentProps<typeof TreeFrame>, 'children' | 'className'>
  tools?: ReactNode
}

export function ContextPanel(p: ContextPanelProps) {
  const [shut, setShut] = useState<Shut>({})
  const [menu, setMenu] = useState<{ rect: DOMRect; items: MenuItem[] } | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [rootCap, setRootCap] = useState(ROOT_CAP)
  // a tag clicked on a page lights up its pages here
  useEffect(() => { const f = (e: Event) => { setTagFilter(String((e as CustomEvent<string>).detail).toLowerCase()); setShut(s => ({ ...s, tags: false })) }; window.addEventListener('nevis:show-tag', f); return () => window.removeEventListener('nevis:show-tag', f) }, [])
  const live = useMemo(() => p.pages.filter(x => !x.deletedAt && !x.database), [p.pages])
  const favs = useMemo(() => live.filter(x => x.favorite && x.kind !== 'folder'), [live])
  const tagList = useMemo<TagInfo[]>(() => {
    const m = new Map<string, TagInfo>()
    for (const pg of live) for (const g of pg.tags ?? []) { const k = g.toLowerCase(); const cur = m.get(k); if (cur) cur.count++; else m.set(k, { key: k, label: g, count: 1 }) }
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [live])
  const taggedPages = useMemo(() => (tagFilter ? live.filter(x => (x.tags ?? []).some(g => g.toLowerCase() === tagFilter)) : []), [live, tagFilter])
  const allRoots = p.index.kids.get(null) ?? []
  const roots = allRoots.slice(0, rootCap)
  const compact = p.settings.pagesView === 'compact'
  const pagesShut = !!shut.pages && favs.length > 0
  const flip = (k: keyof Shut) => setShut(s => ({ ...s, [k]: !s[k] }))
  return (
    <>
      {p.narrow && p.open && <div className="context-backdrop" aria-hidden="true" onClick={p.onClose} />}
      <aside id="workspace-context" className="context-panel" aria-label={p.title} hidden={!p.open} style={p.width ? ({ '--side-w': p.width + 'px' } as React.CSSProperties) : undefined}>
        {!p.narrow && <ResizeHandle label={t('Resize side panel')} width={p.width ?? 264} min={SIDE_MIN} max={SIDE_MAX} onResize={p.onWidth} />}
        <header className="context-heading">
          <h2>{p.title}</h2>
          <div className="context-tools" role="group" aria-label={t('Panel tools')}>
            {p.kind === 'vault' && (
              <>
                <IconButton label={t('Select opened page') + '  ' + commandHint('Reveal active note')} disabled={!p.currentId} onClick={p.onReveal}><Icon name="target" size={15} /></IconButton>
                <IconButton label={t('Expand all')} onClick={p.onExpandAll}><Icon name="chevrons-up-down" size={15} /></IconButton>
                <IconButton label={t('Collapse all')} onClick={p.onCollapseAll}><Icon name="chevrons-down-up" size={15} /></IconButton>
                <IconButton label={t('Options')} aria-haspopup="menu" onClick={e => setMenu({ rect: e.currentTarget.getBoundingClientRect(), items: [
                  { label: t('Always select opened page'), checked: p.settings.treeAutoReveal, onSelect: () => p.onSettings({ treeAutoReveal: !p.settings.treeAutoReveal }) },
                  { label: t('Open with a single click'), checked: p.settings.treeSingleClick, onSelect: () => p.onSettings({ treeSingleClick: !p.settings.treeSingleClick }) },
                  { kind: 'sep' },
                  { kind: 'head', label: t('View as') },
                  { label: t('Tree'), checked: !compact, onSelect: () => p.onSettings({ pagesView: 'tree' }) },
                  { label: t('Compact'), checked: compact, onSelect: () => p.onSettings({ pagesView: 'compact' }) },
                ] })}><Icon name="more-vertical" size={15} /></IconButton>
              </>
            )}
            {p.tools}
          </div>
        </header>
        {menu && <Menu anchor={menu.rect} onClose={() => setMenu(null)} items={menu.items} />}
        <div className="side-scroll" ref={p.setHost}>
          {p.kind === 'vault' && p.open && (
            <div className="side-collections">
              {favs.length > 0 && (
                <div>
                  <div className="fav-zone">
                    <button className={'section' + (shut.favs ? ' shut' : '')} onClick={() => flip('favs')}>{t('Favorites')}<Icon name="chevron-right" size={13} /></button>
                    {!shut.favs && favs.map(f => (
                      <div key={f.id} dir={dirOf(f.title)} className={'row' + (f.id === p.currentId ? ' cur' : '')} style={{ paddingInlineStart: 24 }} onClick={() => p.onOpen(f.id)}>
                        <span className="ic"><PageIcon page={f} /></span><span className="ntitle" dir="auto">{f.title || t('Untitled')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {favs.length > 0 && (
                <div className="tree-heading">
                  <button className={'section' + (shut.pages ? ' shut' : '')} aria-expanded={!shut.pages} onClick={() => flip('pages')}>{t('Pages')}<Icon name="chevron-right" size={13} /></button>
                </div>
              )}
              {!pagesShut && compact && (
                <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom>
                  <TreeFrame className="cmp-list" {...p.treeFrame}><CompactList {...p.rowProps} roots={roots} /></TreeFrame>
                </HorizontalScroll>
              )}
              {!pagesShut && !compact && (
                <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom>
                  <TreeFrame {...p.treeFrame}><div data-testid="tree">{roots.map(r => <TreeRow key={r.id} {...p.rowProps} page={r} depth={0} />)}</div></TreeFrame>
                </HorizontalScroll>
              )}
              {allRoots.length > rootCap && <button className="section" data-testid="tree-more" onClick={() => setRootCap(c => c + ROOT_CAP)}>{t('Show more')} ({allRoots.length - rootCap})</button>}
              {!pagesShut && allRoots.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}
              {tagList.length > 0 && (
                <SidebarTags tags={tagList} active={tagFilter} onPick={setTagFilter} shut={!!shut.tags} onToggle={() => flip('tags')} pages={taggedPages} currentId={p.currentId} onOpen={p.onOpen} />
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
