import type { DocNode } from './docNode'
import { useEffect, useMemo, useState } from 'react'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import { ago } from './ui'
import { Button, Icon, Section, landscapeFor } from './design-system'
import { useSettings } from './settings'
import { PageCoverPreview } from './Cover'
import { locale, t } from './i18n'
import { allTasks, setChecked } from './taskData'
import { countDue } from './cardsDue'

interface Props {
  pages: Page[]
  onOpen: (id: string) => void
  onNew: () => void
  onTable: () => void
  onCards: () => void
  onTemplates: () => void
  onFiles: () => void
  onTasks: () => void
}

const greeting = (h: number) => (h < 5 || h >= 22 ? t('Good night') : h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening'))

/** The first words of a page, for its card: plain text of the first paragraphs. */
function excerpt(content: unknown, max = 120): string {
  let out = ''
  const walk = (n: DocNode | null | undefined) => {
    if (!n || out.length >= max) return
    if (typeof n.text === 'string') out += n.text
    if (Array.isArray(n.content)) {
      for (const c of n.content) {
        walk(c)
        if (out.length >= max) break
      }
      if (n.type === 'paragraph' || n.type === 'heading') out += ' '
    }
  }
  if (content && typeof content === 'object') walk(content as DocNode)
  return out.replace(/\s+/g, ' ').trim().slice(0, max)
}

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

const Quick = ({ icon, title, hint, onClick }: { icon: string; title: string; hint: string; onClick: () => void }) => (
  <button type="button" className="ds-card ds-card--interactive home-quick-item" onClick={onClick}>
    <span className="ds-tile ds-tile--lg home-quick-tile">
      <Icon name={icon} size={22} />
    </span>
    <span>
      <b>{title}</b>
      <small>{hint}</small>
    </span>
  </button>
)

/** Recent pages on Home: never more than this many cards. */
const RECENT_MAX = 6

/** Home composition over real pages, task documents and review scheduling. */
export function Home({ pages, onOpen, onNew, onTable, onCards, onTemplates, onFiles, onTasks }: Props) {
  const settings = useSettings()
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
    void countDue()
      .then((n) => live && setDue(n))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [pages])

  const hour = new Date(now).getHours()
  const scenery = useMemo(() => landscapeFor(hour), [hour])
  const { recent, months, streak } = useMemo(() => {
    const real = pages.filter((p) => p.kind !== 'folder' && !p.database).sort((a, b) => b.updatedAt - a.updatedAt)
    // writing streak: consecutive days with at least one edited page; today may still be empty
    const days = new Set(pages.map((p) => dayKey(p.updatedAt)))
    const today = new Date(now)
    today.setHours(12, 0, 0, 0)
    const back = (n: number) => dayKey(today.getTime() - n * 86_400_000)
    let n = days.has(back(0)) ? 0 : 1
    let streak = 0
    while (days.has(back(n))) (streak++, n++)
    // Current month only: leading blanks followed by one cell per day.
    const monthOf = (back: number) => {
      const year = today.getFullYear(),
        month = today.getMonth() - back
      const first = new Date(year, month, 1, 12)
      const count = new Date(year, month + 1, 0).getDate()
      const cells = [
        ...Array.from({ length: first.getDay() }, () => null),
        ...Array.from({ length: count }, (_, i) => {
          const date = new Date(year, month, i + 1, 12)
          return {
            key: dayKey(date.getTime()),
            n: i + 1,
            done: days.has(dayKey(date.getTime())),
            now: dayKey(date.getTime()) === dayKey(today.getTime()),
            future: date.getTime() > today.getTime() + 43_200_000,
          }
        }),
      ]
      return { label: new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(first), cells, doneCount: cells.filter((c) => c?.done).length }
    }
    return { recent: real.slice(0, RECENT_MAX), months: [monthOf(0)], streak }
  }, [pages, now])
  // pages is a dependency on purpose: toggling a task rewrites its page, which hands Home a new pages array
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => allTasks(), [pages])
  const open = tasks.filter((x) => !x.checked)
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const num = (n: number) => n.toLocaleString(locale())
  const last = recent[0]
  const completed = tasks.length - open.length
  const progress = tasks.length ? Math.round(completed / tasks.length * 100) : 0
  const favorites = pages.filter(page => page.favorite && page.kind !== 'folder').slice(0, 5)
  const pageNames = new Map(pages.map(page => [page.id, page.title || t('Untitled')]))

  return (
    <div className="home">
      <header className="home-hello" data-tone={scenery.dark ? 'dark' : 'light'} data-phase={scenery.phase} style={{ backgroundImage: scenery.css }}>
        <div><span className="home-eyebrow">{t('Your workspace')}</span><h1>{greeting(hour)}</h1><p>{t('A little space to think, create, and keep going.')}</p></div>
        <div className="home-date"><Icon name="home" size={16} /><time dateTime={new Date(now).toISOString()}>{date}</time></div>
      </header>

      <section className="home-quick" aria-label={t('Create something new')}>
        <Quick icon="plus" title={t('New page')} hint={t('Start with a blank page')} onClick={onNew} />
        <Quick icon="templates" title={t('Templates')} hint={t('Start from a template')} onClick={onTemplates} />
        <Quick icon="paperclip" title={t('Files')} hint={t('Browse and organize your pages')} onClick={onFiles} />
        <Quick icon="cards" title={t('Flashcards')} hint={t('Review what you studied')} onClick={onCards} />
      </section>

      <section className="home-focus" aria-labelledby="home-focus-title">
        <header className="home-focus-header"><div><span className="home-eyebrow">{t('A clear next step')}</span><h2 id="home-focus-title">{t('Today, at your pace')}</h2><p>{t('Open tasks across your workspace. Pick up whatever matters next.')}</p></div><Button size="sm" variant="ghost" onClick={onTasks}>{t('View all')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button></header>
        <div className="home-focus-grid">
          <div className="home-focus-tasks">
            <div className="home-focus-summary"><span><Icon name="tasks" size={16} />{t('Open tasks')}<span className="ds-badge">{num(open.length)}</span></span><small>{t('{done} of {total} completed', { done: num(completed), total: num(tasks.length) })}</small></div>
            <div className="home-task-progress" role="progressbar" aria-label={t('Task progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ inlineSize: progress + '%' }} /></div>
            <div className="home-focus-list">{open.length ? open.slice(0, 3).map(task => <div key={task.pageId + ':' + task.index} className="home-task">
              <label><input type="checkbox" className="sr-only" checked={task.checked} aria-label={task.text || t('Untitled')} onChange={() => setChecked(task, !task.checked)} /><span className="ds-check" aria-hidden="true"><svg className="ds-icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span><span dir="auto">{task.text || t('Untitled')}</span></label>
              <button type="button" className="home-task-source" title={t('Open source page')} aria-label={t('Open {page}', { page: pageNames.get(task.pageId) || t('Untitled') })} onClick={() => onOpen(task.pageId)}><Icon name="file" size={12} /><span dir="auto">{pageNames.get(task.pageId)}</span><Icon name="arrow-right" size={12} className="ds-flip" /></button>
            </div>) : <div className="home-focus-empty"><span><Icon name="check" size={20} /></span><div><b>{t('A little breathing room')}</b><p>{t('No open checklist items. Your next idea can start with a blank page.')}</p></div><Button size="sm" onClick={onNew}>{t('New page')}</Button></div>}</div>
          </div>
          <div className="home-review"><div className="home-review-top"><span className="ds-tile"><Icon name="cards" size={20} /></span><span className="home-eyebrow">{t('Keep it fresh')}</span></div><div><strong>{num(due)}</strong><span>{t('cards ready to review')}</span></div><p>{due ? t('A short review helps good ideas stay with you.') : t('You are up to date. Come back when your next cards are ready.')}</p><Button variant={due ? 'primary' : 'default'} size="sm" onClick={onCards}>{t(due ? 'Start review' : 'Open flashcards')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button></div>
        </div>
      </section>

      <div className="home-grid">
        <div className="home-continue-row">
          {last && <button type="button" className="home-resume" onClick={() => onOpen(last.id)}>
            <span className="home-resume-ic">{settings.showIcons ? <PageIcon page={last} /> : <Icon name="file" size={22} />}</span>
            <span className="home-resume-t"><small>{t('Continue where you left off')}</small><b dir="auto">{last.title || t('Untitled')}</b></span>
            <span className="home-resume-updated">{ago(last.updatedAt)}</span><span className="home-resume-open"><Icon name="arrow-right" size={18} className="ds-flip" /></span>
          </button>}
          {favorites.length > 0 && <div className="home-pinned"><small>{t('Favorites')}</small><div>{favorites.map(page => <button type="button" key={page.id} title={page.title || t('Untitled')} onClick={() => onOpen(page.id)}><span dir="auto">{page.title || t('Untitled')}</span></button>)}</div></div>}
        </div>
        <div className="home-main">
          <Section className="home-recent-section" title={t('Recent pages')} action={<button type="button" className="home-link" onClick={onTable}>{t('View all')}<Icon name="arrow-right" size={14} /></button>}>
            {recent.length === 0 ? <div className="ds-empty ds-card home-empty"><Icon name="file" size={24} /><b>{t('No pages yet')}</b><p>{t('A blank page is a good place to begin.')}</p><Button variant="primary" size="sm" onClick={onNew}>{t('New page')}</Button></div> : <div className="home-cards">{recent.map(page => <button type="button" key={page.id} className="ds-card ds-card--interactive home-card" onClick={() => onOpen(page.id)}>
              {settings.showCovers && page.cover && <PageCoverPreview cover={page.cover} className="home-card-cover" />}
              <span className="home-card-top">{settings.showIcons && <PageIcon page={page} />}<small className="ds-muted">{ago(page.updatedAt)}</small></span>
              <b dir="auto">{page.title || t('Untitled')}</b><span className="home-card-ex" dir="auto">{excerpt(page.content)}</span>
              <span className="home-card-tags">{page.tags?.slice(0, 2).map(tag => <span key={tag} className="ds-chip" dir="auto">{tag}</span>)}</span>
            </button>)}</div>}
          </Section>
        </div>
        <aside className="home-side">
          <Section title={t('Writing streak')}>
            <div className="ds-card home-streak">
              <div className="home-streak-head"><span className="home-flame"><Icon name="flame" size={20} /></span><b>{num(streak)}</b><span className="ds-muted">{t('days in a row')}</span></div>
              {months.map(month => <div key={month.label} className="home-month-block">
                <div className="home-month-head"><b>{month.label}</b><span className="ds-muted">{t('{n} days written', { n: num(month.doneCount) })}</span></div>
                <div className="home-month" aria-label={month.label}>
                  {Array.from({ length: 7 }, (_, index) => <span key={index} className="wd">{new Intl.DateTimeFormat(locale(), { weekday: 'narrow' }).format(new Date(2023, 0, 1 + index))}</span>)}
                  {month.cells.map((cell, index) => cell ? <i key={cell.key} className={(cell.done ? 'done ' : '') + (cell.now ? 'now ' : '') + (cell.future ? 'future' : '')} title={num(cell.n)}>{cell.done ? <Icon name="check" size={12} /> : num(cell.n)}</i> : <i key={'blank-' + index} className="pad" />)}
                </div>
              </div>)}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  )
}
