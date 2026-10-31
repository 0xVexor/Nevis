import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import { ago } from './ui'
import { Icon } from './design-system'
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
  const walk = (n: any) => {
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
  if (content && typeof content === 'object') walk(content)
  return out.replace(/\s+/g, ' ').trim().slice(0, max)
}

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

const Quick = ({ icon, title, hint, onClick }: { icon: string; title: string; hint: string; onClick: () => void }) => (
  <button type="button" className="home-quick-item" onClick={onClick}>
    <span className="ds-tile ds-tile--lg home-quick-tile"><Icon name={icon} size={22} /></span>
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

/** Home: greeting, ways to start, where you left off, recent pages; today's checklist, writing streak and pinned pages beside them. */
export function Home({ pages, onOpen, onNew, onTable, onCards, onTemplates, onFiles, onTasks }: Props) {
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
  const { recent, favs, week, streak } = useMemo(() => {
    const real = pages.filter((p) => p.kind !== 'folder' && !p.database).sort((a, b) => b.updatedAt - a.updatedAt)
    // writing streak: consecutive days with at least one edited page; today may still be empty
    const days = new Set(pages.map((p) => dayKey(p.updatedAt)))
    const today = new Date(now)
    today.setHours(12, 0, 0, 0)
    const back = (n: number) => dayKey(today.getTime() - n * 86_400_000)
    let n = days.has(back(0)) ? 0 : 1
    let streak = 0
    while (days.has(back(n))) (streak++, n++)
    const sunday = today.getDay()
    const week = Array.from({ length: 7 }, (_, i) => {
      const off = sunday - i
      return { key: back(off), now: off === 0, date: new Date(today.getTime() - off * 86_400_000) }
    })
    return { recent: real.slice(0, 6), favs: pages.filter((p) => p.kind !== 'folder' && p.favorite).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), week: week.map((d) => ({ ...d, done: days.has(d.key) })), streak }
  }, [pages, now])
  // pages is a dependency on purpose: toggling a task rewrites its page, which hands Home a new pages array
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => allTasks(), [pages])
  const open = tasks.filter((x) => !x.checked)
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const num = (n: number) => n.toLocaleString(locale())
  const last = recent[0]

  return (
    <div className="home">
      <header className="home-hello">
        <small>{date}</small>
        <h1>{greeting(hour)}</h1>
        <p>{t('{n} tasks left', { n: num(open.length) })} · {t('{n} flashcards due', { n: num(due) })}</p>
      </header>

      <section className="home-quick" aria-label={t('Create something new')}>
        <Quick icon="plus" title={t('New page')} hint={t('Start with a blank page')} onClick={onNew} />
        <Quick icon="templates" title={t('Templates')} hint={t('Start from a template')} onClick={onTemplates} />
        <Quick icon="paperclip" title={t('Files')} hint={t('Browse and organize your pages')} onClick={onFiles} />
        <Quick icon="cards" title={t('Flashcards')} hint={t('Review what you studied')} onClick={onCards} />
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

          <Section title={t('Recent pages')} action={<button type="button" className="home-link" onClick={onTable}>{t('View all')}<Icon name="arrow-right" size={14} /></button>}>
            {recent.length === 0 ? <div className="ds-empty ds-card"><b>{t('No pages yet')}</b></div> : (
              <div className="home-cards">
                {recent.map((p) => {
                  const text = excerpt(p.content)
                  return (
                    <button type="button" key={p.id} className="ds-card ds-card--interactive home-card" onClick={() => onOpen(p.id)}>
                      <span className="home-card-top"><PageIcon page={p} /><small className="ds-muted">{ago(p.updatedAt)}</small></span>
                      <b dir="auto">{p.title || t('Untitled')}</b>
                      <span className="home-card-ex" dir="auto">{text}</span>
                      <span className="home-card-tags">{p.tags?.slice(0, 2).map((g) => <span key={g} className="ds-chip">{g}</span>)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </Section>
        </div>

        <aside className="home-side">
          <Section title={t('Today')}>
            <div className="ds-card home-today">
              <div className="home-today-head">
                <Ring done={tasks.length - open.length} total={tasks.length} />
                <span><b>{open.length ? t('{n} tasks left', { n: num(open.length) }) : t('All caught up')}</b><small className="ds-muted">{open.length ? t('Checklist items from all your pages') : t('Nothing left for today. Add a task to plan ahead.')}</small></span>
              </div>
              {open.slice(0, 4).map((x) => (
                <label key={x.pageId + ':' + x.index} className="home-task">
                  <input type="checkbox" className="sr-only" checked={x.checked} onChange={() => setChecked(x, !x.checked)} />
                  <span className="ds-check" aria-hidden="true"><svg className="ds-icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                  <span dir="auto">{x.text || t('Untitled')}</span>
                </label>
              ))}
              {open.length > 4 && <button type="button" className="home-link home-more" onClick={onTasks}>{t('View all')}<Icon name="arrow-right" size={14} /></button>}
            </div>
          </Section>

          <Section title={t('Writing streak')}>
            <div className="ds-card home-streak">
              <div className="home-streak-head"><span className="home-flame"><Icon name="flame" size={20} /></span><b>{num(streak)}</b><span className="ds-muted">{t('days in a row')}</span></div>
              <div className="home-week">
                {week.map((d) => (
                  <div key={d.key} className={d.done ? 'done' : d.now ? 'now' : ''}>
                    <i>{d.done && <Icon name="check" size={14} />}</i>
                    <span>{new Intl.DateTimeFormat(locale(), { weekday: 'narrow' }).format(d.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>

          <Section title={t('Pinned')}>
            <div className="ds-card home-list">
              {favs.length ? favs.map((p) => (
                <button type="button" key={p.id} className="home-row" onClick={() => onOpen(p.id)}>
                  <PageIcon page={p} />
                  <span className="home-row-t" dir="auto">{p.title || t('Untitled')}</span>
                  <span className="ds-muted home-row-m">{ago(p.updatedAt)}</span>
                </button>
              )) : <div className="ds-empty">{t('Star a page to pin it here')}</div>}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  )
}
