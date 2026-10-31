import { shortcutLabel } from './shortcuts'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import { MenuItem, MenuSep, Popover, ago } from './ui'
import * as Ic from './icons'
import { locale, t } from './i18n'
import { allTasks, setChecked } from './taskData'
import { countDue } from './cardsDue'

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

const greeting = (h: number) => (h < 5 || h >= 22 ? t('Good night') : h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening'))

const Quick = ({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }) => (
  <button type="button" className="home-quick-item" onClick={onClick}>
    <span className="ds-tile ds-tile--lg home-quick-tile">{icon}</span>
    <span><b>{title}</b><small>{hint}</small></span>
  </button>
)

const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => (
  <section className="home-section">
    <header><h2>{title}</h2>{action}</header>
    {children}
  </section>
)

/** Progress ring: done / total of the checklist items across every page. */
function Ring({ done, total }: { done: number; total: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <span className="home-ring" aria-hidden="true">
      <svg viewBox="0 0 80 80"><circle cx="40" cy="40" r={r} className="home-ring-bg" /><circle cx="40" cy="40" r={r} className="home-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - (total ? done / total : 0))} /></svg>
      <b>{done.toLocaleString(locale())}/{total.toLocaleString(locale())}</b>
    </span>
  )
}

/** Home: a calm overview. Greeting, the ways to start something, where you left off, and today's checklist items. */
export function Home({ pages, onOpen, onNew, onFolder, onTable, onCards, onSearch, onNewDatabase, onNewBoard, onNewList, onDatabases, onDrawings, onTasks, onTemplates, onWorkspaces }: Props) {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [due, setDue] = useState(0)
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
  useEffect(() => {
    let live = true
    void countDue().then((n) => live && setDue(n)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [pages])

  const hour = new Date(now).getHours()
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const { recent, today, favs } = useMemo(() => {
    const real = pages.filter((p) => p.kind !== 'folder' && !p.database).sort((a, b) => b.updatedAt - a.updatedAt)
    return { recent: real.slice(0, 6), today: real.filter((p) => p.updatedAt >= midnight), favs: pages.filter((p) => p.kind !== 'folder' && p.favorite).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8) }
  }, [pages, midnight])
  // pages is a dependency on purpose: toggling a task rewrites its page, which hands Home a new pages array
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => allTasks(), [pages])
  const open = tasks.filter((x) => !x.checked)
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const choose = (run: () => void) => { setMenu(null); run() }
  const last = recent[0]

  const row = (p: Page, meta?: string) => (
    <button type="button" key={p.id} className="home-row" onClick={() => onOpen(p.id)}>
      <PageIcon page={p} />
      <span className="home-row-t" dir="auto">{p.title || t('Untitled')}</span>
      {meta && <span className="ds-muted home-row-m">{meta}</span>}
    </button>
  )

  return (
    <div className="home">
      <div className="home-bar">
        <button type="button" className="home-search" onClick={onSearch}>
          <Ic.Search size={16} /><span>{t('Search pages…')}</span><kbd dir="ltr">{shortcutLabel(['Mod', 'K'])}</kbd>
        </button>
        <div className="ds-split home-new">
          <button type="button" className="ds-btn ds-btn--primary" onClick={onNew}><Ic.Plus size={16} />{t('New')}</button>
          <button type="button" className="ds-btn ds-btn--primary" aria-label={t('More')} aria-expanded={!!menu} onClick={(e) => setMenu(menu ? null : e.currentTarget.parentElement!.getBoundingClientRect())}><Ic.Chevron size={14} /></button>
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

      <header className="home-hello">
        <small>{date}</small>
        <h1>{greeting(hour)}</h1>
        <p>{t('{n} tasks left', { n: open.length.toLocaleString(locale()) })} · {t('{n} flashcards due', { n: due.toLocaleString(locale()) })}</p>
      </header>

      <section className="home-quick" aria-label={t('Create something new')}>
        <Quick icon={<Ic.Page />} title={t('New page')} hint={t('Start with a blank page')} onClick={onNew} />
        <Quick icon={<Ic.Table />} title={t('New database')} hint={t('Tables, views, forms and dashboards')} onClick={onNewDatabase} />
        <Quick icon={<Ic.Pencil />} title={t('New board')} hint={t('Sketch ideas on an open canvas')} onClick={onNewBoard} />
        <Quick icon={<Ic.Checklist />} title={t('New to-do list')} hint={t('Plan your next steps')} onClick={onNewList} />
      </section>

      <div className="home-grid">
        <div className="home-main">
          {last && (
            <Section title={t('Continue where you left off')}>
              <button type="button" className="home-resume" onClick={() => onOpen(last.id)}>
                <span className="home-resume-ic"><PageIcon page={last} /></span>
                <span className="home-resume-t"><b dir="auto">{last.title || t('Untitled')}</b><small>{t('Updated {when}', { when: ago(last.updatedAt) })}</small></span>
                <span className="ds-btn ds-btn--primary ds-btn--sm">{t('Open')}</span>
              </button>
            </Section>
          )}

          <Section title={t('Recent pages')} action={<button type="button" className="home-link" onClick={onTable}>{t('View all')}<Ic.Arrow size={14} /></button>}>
            {recent.length === 0 ? <div className="ds-empty ds-card"><b>{t('No pages yet')}</b></div> : (
              <div className="home-cards">
                {recent.map((p) => (
                  <button type="button" key={p.id} className="ds-card ds-card--interactive home-card" onClick={() => onOpen(p.id)}>
                    <span className="home-card-top"><PageIcon page={p} /><small className="ds-muted">{ago(p.updatedAt)}</small></span>
                    <b dir="auto">{p.title || t('Untitled')}</b>
                    {p.tags?.length ? <span className="home-card-tags">{p.tags.slice(0, 2).map((g) => <span key={g} className="ds-chip">{g}</span>)}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title={t('Explore your workspace')}>
            <nav className="home-collections" aria-label={t('Explore your workspace')}>
              <button type="button" className="ds-card ds-card--interactive" onClick={onDatabases}><span className="ds-tile ds-tile--md"><Ic.Table /></span><span><b>{t('Databases')}</b><small>{t('Tables, boards, calendars, forms and dashboards.')}</small></span></button>
              <button type="button" className="ds-card ds-card--interactive" onClick={onDrawings}><span className="ds-tile ds-tile--md"><Ic.Pencil /></span><span><b>{t('Drawings')}</b><small>{t('Find your boards and drawings from every page.')}</small></span></button>
              <button type="button" className="ds-card ds-card--interactive" onClick={onTasks}><span className="ds-tile ds-tile--md"><Ic.Checklist /></span><span><b>{t('Tasks')}</b><small>{t('Bring your to-do lists and page checklists together.')}</small></span></button>
            </nav>
          </Section>
        </div>

        <aside className="home-side">
          <Section title={t('Today')}>
            <div className="ds-card home-today">
              <div className="home-today-head">
                <Ring done={tasks.length - open.length} total={tasks.length} />
                <span><b>{open.length ? t('{n} tasks left', { n: open.length.toLocaleString(locale()) }) : t('All caught up')}</b><small className="ds-muted">{open.length ? t('Checklist items from all your pages') : t('Nothing left for today. Add a task to plan ahead.')}</small></span>
              </div>
              {open.slice(0, 4).map((x) => (
                <label key={x.pageId + ':' + x.index} className="home-task">
                  <input type="checkbox" className="sr-only" checked={x.checked} onChange={() => setChecked(x, !x.checked)} />
                  <span className="ds-check" aria-hidden="true"><svg className="ds-icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                  <span dir="auto">{x.text || t('Untitled')}</span>
                </label>
              ))}
              {open.length > 4 && <button type="button" className="home-link home-more" onClick={onTasks}>{t('View all')}<Ic.Arrow size={14} /></button>}
            </div>
          </Section>
          <Section title={t('Pinned')}>
            <div className="ds-card home-list">{favs.length ? favs.map((p) => row(p)) : <div className="ds-empty">{t('Star a page to pin it here')}</div>}</div>
          </Section>
          <Section title={t('Edited today')}>
            <div className="ds-card home-list">{today.length ? today.slice(0, 6).map((p) => row(p, ago(p.updatedAt))) : <div className="ds-empty">{t('Nothing edited today')}</div>}</div>
          </Section>
          <Section title={t('Quick access')}>
            <div className="ds-card home-list">
              <button type="button" className="home-row" onClick={onTemplates}><Ic.Blocks size={16} /><span className="home-row-t">{t('Templates')}</span></button>
              <button type="button" className="home-row" onClick={onCards}><Ic.Cards size={16} /><span className="home-row-t">{t('Flashcards')}</span>{due > 0 && <span className="ds-badge">{due.toLocaleString(locale())}</span>}</button>
              <button type="button" className="home-row" onClick={onFolder}><Ic.Folder size={16} /><span className="home-row-t">{t('New folder')}</span></button>
              {onWorkspaces && <button type="button" className="home-row" onClick={onWorkspaces}><Ic.Layers size={16} /><span className="home-row-t">{t('Workspaces…')}</span></button>}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  )
}
