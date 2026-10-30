import { shortcutLabel } from './shortcuts'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Page } from './repo'
import { CoverThumb } from './Cover'
import { PageIcon } from './PageIcon'
import { MenuItem, MenuSep, Popover, ago } from './ui'
import * as Ic from './icons'
import { locale, t } from './i18n'

interface Props {
  pages: Page[]
  onOpen: (id: string) => void
  onNew: () => void
  onFolder: () => void
  onTable: () => void
  onCards: () => void
  onSearch: () => void
  onNewDatabase: () => void
  onNewBoard: () => void
  onNewList: () => void
  onDatabases: () => void
  onDrawings: () => void
  onTasks: () => void
  onTemplates: () => void
  onWorkspaces?: () => void
}

const greeting = (h: number) => {
  return h < 5 || h >= 22 ? t('Good night') : h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening')
}

type Tone = 'violet' | 'blue' | 'green' | 'orange'
const Action = ({ icon, tone, title, hint, onClick }: { icon: ReactNode; tone: Tone; title: string; hint: string; onClick: () => void }) => (
  <button type="button" className="hm-act" onClick={onClick}>
    <span className={'hm-tile ' + tone}>{icon}</span><Ic.Arrow size={15} />
    <b>{title}</b><small>{hint}</small>
  </button>
)
const Box = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <section className="hm-box"><header><span className="hm-box-ic">{icon}</span><h3>{title}</h3></header>{children}</section>
)

/** Home lists workspace pages separately from database rows and exposes every creation path. */
export function Home({ pages, onOpen, onNew, onFolder, onTable, onCards, onSearch, onNewDatabase, onNewBoard, onNewList, onDatabases, onDrawings, onTasks, onTemplates, onWorkspaces }: Props) {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  const hour = new Date(now).getHours()
  const landscape = hour < 5 || hour >= 22 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const landscapeUrl = import.meta.env.BASE_URL + 'home-landscapes/' + landscape + '.png'
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const { real, recent, today, favs, databases, boards, lists } = useMemo(() => {
    const real = pages.filter((p) => p.kind !== 'folder' && !p.database).sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      real, recent: real.slice(0, 6), today: real.filter((p) => p.updatedAt >= midnight),
      favs: pages.filter((p) => p.kind !== 'folder' && p.favorite).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), databases: real.filter((p) => p.dbHost),
      boards: real.filter((p) => p.kind === 'board'), lists: real.filter((p) => p.kind === 'todo'),
    }
  }, [pages, midnight])
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const count = (n: number) => n.toLocaleString(locale())
  const choose = (run: () => void) => { setMenu(null); run() }
  const row = (p: Page, meta?: string) => (
    <button type="button" key={p.id} className="hm-row" onClick={() => onOpen(p.id)}>
      <span className="hm-row-ic"><PageIcon page={p} /></span>
      <span className="hm-row-t" dir="auto">{p.title || t('Untitled')}</span>
      {meta && <span className="hm-row-m">{meta}</span>}
    </button>
  )
  const collections = [
    { title: t('Databases'), hint: t('Tables, boards, calendars, forms and dashboards.'), icon: <Ic.Table size={19} />, run: onDatabases },
    { title: t('Drawings'), hint: t('Find your boards and drawings from every page.'), icon: <Ic.Pencil size={19} />, run: onDrawings },
    { title: t('Tasks'), hint: t('Bring your to-do lists and page checklists together.'), icon: <Ic.Checklist size={19} />, run: onTasks },
  ]

  return (
    <div className="hm">
      <div className="hm-bar">
        <button type="button" className="hm-search" onClick={onSearch}><Ic.Search size={16} /><span>{t('Search pages…')}</span><kbd dir="ltr">{shortcutLabel(['Mod', 'K'])}</kbd></button>
        <div className="hm-new">
          <button type="button" className="hm-new-main" onClick={onNew}><Ic.Plus size={16} />{t('New')}</button>
          <button type="button" className="hm-new-more" aria-label={t('More')} aria-expanded={!!menu} onClick={(e) => setMenu(menu ? null : e.currentTarget.parentElement!.getBoundingClientRect())}><Ic.Chevron size={14} /></button>
        </div>
      </div>
      {menu && <Popover anchor={menu} align="end" onClose={() => setMenu(null)}><div className="menu">
        <MenuItem icon={<Ic.Page />} label={t('New page')} onClick={() => choose(onNew)} />
        <MenuItem icon={<Ic.Table />} label={t('New database')} onClick={() => choose(onNewDatabase)} />
        <MenuItem icon={<Ic.Pencil />} label={t('New board')} onClick={() => choose(onNewBoard)} />
        <MenuItem icon={<Ic.Checklist />} label={t('New to-do list')} onClick={() => choose(onNewList)} />
        <MenuItem icon={<Ic.Folder />} label={t('New folder')} onClick={() => choose(onFolder)} />
        <MenuSep /><MenuItem icon={<Ic.Blocks />} label={t('Templates')} onClick={() => choose(onTemplates)} />
      </div></Popover>}

      <div className="hm-grid">
        <div className="hm-main">
          <section className="hm-hero hm-overview" data-landscape={landscape}>
            <img key={landscape} className="hm-landscape" src={landscapeUrl} alt="" aria-hidden="true" decoding="async" />
            <div className="hm-landscape-shade" aria-hidden="true" />
            <div className="hm-hero-tx">
              <small>{date}</small>
              <h1>{greeting(hour)}</h1>
              <p>{t('Write, plan, draw and organize in one workspace.')}</p>
              <button type="button" className="hm-cta" onClick={onTemplates}><Ic.Blocks size={17} />{t('Start with a template')}<Ic.Arrow size={15} /></button>
            </div>
            <div className="hm-stats">
              <button type="button" onClick={onTable}><b>{count(real.length)}</b><span>{t('Pages')}</span></button>
              <button type="button" onClick={onDatabases}><b>{count(databases.length)}</b><span>{t('Databases')}</span></button>
              <button type="button" onClick={onDrawings}><b>{count(boards.length)}</b><span>{t('Boards')}</span></button>
              <button type="button" onClick={onTasks}><b>{count(lists.length)}</b><span>{t('To-do lists')}</span></button>
            </div>
          </section>

          <section className="hm-acts" aria-label={t('Create something new')}>
            <Action tone="violet" icon={<Ic.Page size={20} />} title={t('New page')} hint={t('Start with a blank page')} onClick={onNew} />
            <Action tone="blue" icon={<Ic.Table size={20} />} title={t('New database')} hint={t('Tables, views, forms and dashboards')} onClick={onNewDatabase} />
            <Action tone="green" icon={<Ic.Pencil size={20} />} title={t('New board')} hint={t('Sketch ideas on an open canvas')} onClick={onNewBoard} />
            <Action tone="orange" icon={<Ic.Checklist size={20} />} title={t('New to-do list')} hint={t('Plan your next steps')} onClick={onNewList} />
          </section>

          <div className="hm-sec"><h2><Ic.Layers size={18} />{t('Explore your workspace')}</h2></div>
          <nav className="hm-collections" aria-label={t('Explore your workspace')}>
            {collections.map((c) => <button type="button" key={c.title} className="hm-collection" onClick={c.run}>
              <span className="hm-box-ic">{c.icon}</span><span><b>{c.title}</b><small>{c.hint}</small></span><Ic.Arrow size={14} />
            </button>)}
          </nav>

          <div className="hm-sec"><h2><Ic.History size={18} />{t('Recent pages')}</h2><button type="button" className="hm-link" onClick={onTable}>{t('View all')}<Ic.Arrow size={14} /></button></div>
          {recent.length === 0 ? <div className="hm-empty">{t('No pages yet')}</div> : <div className="hm-cards">
            {recent.map((p) => <button type="button" key={p.id} className="hm-card" onClick={() => onOpen(p.id)}>
              <CoverThumb cover={p.cover ?? { kind: 'gradient', id: p.dbHost ? 'aurora' : p.kind === 'board' ? 'lagoon' : 'peachmist' }} className="hm-card-cover" />
              <span className="hm-card-b"><span className="hm-row-ic"><PageIcon page={p} /></span><span className="hm-card-t"><b dir="auto">{p.title || t('Untitled')}</b><small>{t('Updated {when}', { when: ago(p.updatedAt) })}</small></span></span>
            </button>)}
          </div>}
        </div>

        <aside className="hm-side">
          <Box icon={<Ic.Clock size={18} />} title={t('Edited today')}>{today.length ? today.slice(0, 6).map((p) => row(p, ago(p.updatedAt))) : <div className="hm-empty">{t('Nothing edited today')}</div>}</Box>
          <Box icon={<Ic.Star size={18} />} title={t('Pinned')}>{favs.length ? favs.map((p) => row(p)) : <div className="hm-empty">{t('Star a page to pin it here')}</div>}</Box>
          <Box icon={<Ic.Blocks size={18} />} title={t('Quick access')}>
            <button type="button" className="hm-row" onClick={onTemplates}><Ic.Blocks size={16} /><span className="hm-row-t">{t('Templates')}</span><Ic.Arrow size={14} /></button>
            <button type="button" className="hm-row" onClick={onCards}><Ic.Cards size={16} /><span className="hm-row-t">{t('Flashcards')}</span><Ic.Arrow size={14} /></button>
            <button type="button" className="hm-row" onClick={onFolder}><Ic.Folder size={16} /><span className="hm-row-t">{t('New folder')}</span><Ic.Plus size={14} /></button>
            {onWorkspaces && <button type="button" className="hm-row" onClick={onWorkspaces}><Ic.Layers size={16} /><span className="hm-row-t">{t('Workspaces…')}</span><Ic.Arrow size={14} /></button>}
          </Box>
        </aside>
      </div>
    </div>
  )
}
