import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { DocNode } from './docNode'
import type { Page } from './repo'
import type { Task } from './taskData'
import { PageIcon } from './PageIcon'
import { ago } from './ui'
import { Button, Icon, Row, Section, useMenu, landscapeFor, useUIMotion } from './design-system'
import { locale, t } from './i18n'

export interface HomeActions {
  onOpen: (id: string) => void
  onNew: () => void
  onTable: () => void
  onCards: () => void
  onTemplates: () => void
  onTemplate: (id: string) => void
  onImport: () => void
  onFiles: () => void
  onTasks: () => void
}
interface Props extends HomeActions {
  pages: Page[]
  tasks: Task[]
  due: number | null
  now: number
  showIcons: boolean
  onCheck: (task: Task, checked: boolean) => void
  note: ReactNode
  draftId?: string | null
}

function excerpt(content: unknown): string {
  let text = ''
  const walk = (node: DocNode) => {
    if (text.length >= 160) return
    if (typeof node.text === 'string') text += node.text
    node.content?.forEach(walk)
    if (['paragraph', 'heading', 'listItem'].includes(node.type ?? '')) text += ' '
  }
  if (content && typeof content === 'object') walk(content as DocNode)
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** Presentation only: preview empty/full Home without touching a vault. */
export function HomeScreen({ pages, tasks, due, now, showIcons, onCheck, onOpen, onNew, onTable, onCards, onTemplates, onTemplate, onImport, onFiles, onTasks, note, draftId }: Props) {
  const motionOf = useUIMotion()
  const { open: openMenu, menu } = useMenu()
  const documents = pages.filter(p => !p.deletedAt && p.kind !== 'folder' && !p.database && p.id !== draftId).sort((a, b) => b.updatedAt - a.updatedAt)
  // Keep the writing surface mounted when the first keystroke creates a page.
  const [firstVisit] = useState(() => documents.length === 0)
  const [quickOpen, setQuickOpen] = useState(false)
  const recent = documents.slice(1, 4)
  const last = documents[0]
  const favorites = documents.filter(p => p.favorite).slice(0, 3)
  const openTasks = tasks.filter(task => !task.checked)
  const byId = new Map(pages.map(page => [page.id, page]))
  const num = (n: number) => n.toLocaleString(locale())
  const hour = new Date(now).getHours()
  const scenery = useMemo(() => landscapeFor(hour), [hour])
  const showScene = !firstVisit && documents.length > 0
  const greeting = hour < 5 || hour >= 22 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const title = (page: Page) => page.title || t('Untitled')
  const context = (event: MouseEvent, page: Page) => {
    event.preventDefault()
    openMenu([
      { label: 'Open source page', icon: <Icon name="file" />, onSelect: () => onOpen(page.id) },
      { label: 'View all pages', icon: <Icon name="table" />, onSelect: onTable },
    ], event)
  }
  const editedDays = new Set(documents.map(page => dayKey(new Date(page.updatedAt))))
  const day = (offset: number) => {
    const date = new Date(now)
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() + offset)
    return date
  }
  let streak = 0
  let offset = editedDays.has(dayKey(day(0))) ? 0 : -1
  while (editedDays.has(dayKey(day(offset)))) { streak++; offset-- }
  const activity = Array.from({ length: 28 }, (_, i) => {
    const date = day(i - 27)
    return { date, done: editedDays.has(dayKey(date)) }
  })

  return (
    <div className="home" data-empty={firstVisit}>
      <header className={'home-header' + (showScene ? ' home-header--scene' : '')} data-tone={showScene ? (scenery.dark ? 'dark' : 'light') : undefined} data-phase={showScene ? scenery.phase : undefined} style={showScene ? { backgroundImage: scenery.css } : undefined}>
        <div><div className="home-welcome-line"><h1>{t(greeting)}</h1><time dateTime={new Date(now).toISOString()}>{date}</time></div><p className="home-welcome-text">{t('An idea, a plan, a few words. Start here.')}</p></div>
        {!firstVisit && <Button variant="primary" icon={<Icon name="plus" />} onClick={onNew}>{t('New page')}</Button>}
      </header>
      {firstVisit ? (
        <div className="ds-layout home-first-layout">
          <div className="ds-layout-cols home-first-columns">
            <section className="home-first-writing" aria-labelledby="home-first-title">
              <div className="home-first-heading"><h2 id="home-first-title">{t('Your first note')}</h2></div>
              {note}
            </section>
            <aside className="home-start-options" aria-label={t('Other ways to start')}>
              <h2>{t('Start with a little structure')}</h2>
              <p>{t('Choose a template and make it yours.')}</p>
              <div className="home-template-choices">
                {[
                  { id: 'meeting', icon: 'users', title: 'Meeting notes', preview: 'Agenda · Decisions · Next steps' },
                  { id: 'lecture', icon: 'book', title: 'Lecture', preview: 'Key ideas · Notes · Questions' },
                  { id: 'todo', icon: 'checklist', title: 'To-do list', preview: 'Today · This week · Later' },
                ].map(template => <button key={template.id} type="button" className="home-template-choice" onClick={() => onTemplate(template.id)} onContextMenu={event => { event.preventDefault(); openMenu([{ label: 'Use this template', onSelect: () => onTemplate(template.id) }], event) }}>
                  <Icon name={template.icon} /><span><b>{t(template.title)}</b><small>{t(template.preview)}</small></span><Icon name="arrow-right" className="ds-flip" size={14} />
                </button>)}
              </div>
              <Button variant="ghost" size="sm" onClick={onTemplates}>{t('All templates')}<Icon name="arrow-right" className="ds-flip" size={14} /></Button>
              <div className="home-import-start"><Icon name="upload" size={20} /><h3>{t('Already have notes?')}</h3><p>{t('Bring in Markdown files or an Obsidian vault.')}</p><Button size="sm" onClick={onImport}>{t('Import notes')}</Button></div>
            </aside>
          </div>
        </div>
      ) : (
        <>
          <nav className="home-tools" aria-label={t('Workspace tools')}>
            <Button variant="ghost" size="sm" icon={<Icon name="templates" />} onClick={onTemplates}>{t('Templates')}</Button>
            <Button variant="ghost" size="sm" icon={<Icon name="paperclip" />} onClick={onFiles}>{t('Files')}</Button>
          </nav>
          <div className="ds-layout home-layout">
            <div className="ds-layout-cols home-columns">
              <div className="home-documents">
                {last && <section className="home-return">
                  <h2>{t('Continue where you left off')}</h2>
                  <button type="button" className="home-return-page" onClick={() => onOpen(last.id)} onContextMenu={event => context(event, last)}>
                    <span className="home-return-meta">{showIcons && <PageIcon page={last} />}<time>{ago(last.updatedAt)}</time></span>
                    <b dir="auto">{title(last)}</b><span className="home-return-excerpt" dir="auto">{excerpt(last.content) || t('Empty page')}</span>
                    <span className="home-return-open">{t('Continue writing')}<Icon name="arrow-right" className="ds-flip" size={14} /></span>
                  </button>
                </section>}
                <div className="home-quick-note">
                  <button type="button" className="home-quick-trigger" aria-expanded={quickOpen} onClick={() => setQuickOpen(!quickOpen)}><Icon name="pencil" /><span>{t('Write a quick note…')}</span><Icon name="chevron-down" /></button>
                  <div hidden={!quickOpen}>{note}</div>
                </div>
                {recent.length > 0 &&
                <Section title={t('Recent pages')} action={<Button size="sm" variant="ghost" onClick={onTable}>{t('View all')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button>}>
                  <div className="home-page-list">
                    {recent.map(page => (
                      <Row as="button" key={page.id} className="home-page" text={title(page)}
                        onClick={() => onOpen(page.id)} onContextMenu={(event) => context(event, page)}
                        icon={showIcons ? <span className="home-page-mark"><PageIcon page={page} /></span> : undefined}
                        trailing={<span className="home-page-end"><time dateTime={new Date(page.updatedAt).toISOString()}>{ago(page.updatedAt)}</time><Icon name="arrow-right" size={16} className="ds-flip" /></span>}>
                        <span className="home-page-title" dir="auto">{title(page)}</span>
                        <span className="home-page-excerpt" dir="auto">{excerpt(page.content) || (page.kind === 'board' ? t('Drawing') : t('Empty page'))}</span>
                        {page.parentId && byId.has(page.parentId) && <span className="home-page-location" dir="auto">{title(byId.get(page.parentId)!)}</span>}
                      </Row>
                    ))}
                  </div>
                </Section>}
              </div>
              <aside className="home-aside" aria-label={t('Workspace overview')}>
                <Section title={t('Favorites')}>
                  {favorites.length ? <div className="home-favorite-list">{favorites.map(page => (
                    <Row as="button" key={page.id} className="home-favorite" text={title(page)} onClick={() => onOpen(page.id)} onContextMenu={event => context(event, page)} icon={showIcons ? <PageIcon page={page} /> : undefined}><span dir="auto">{title(page)}</span></Row>
                  ))}</div> : <p className="home-note">{t('Favorite a page to keep it here.')}</p>}
                </Section>
                <Section title={t('Open tasks')} action={<Button variant="ghost" size="sm" onClick={onTasks}>{t('View all')}</Button>}>
                  {openTasks.length ? <div className="home-task-list"><AnimatePresence initial={false}>{openTasks.slice(0, 3).map(task => (
                    <motion.div className="home-task" key={`${task.pageId}:${task.index}`} layout={motionOf.reduced ? false : 'position'} exit={{ opacity: 0, height: 0 }} transition={{ ...motionOf.transition, layout: motionOf.spring }} onContextMenu={event => {
                      event.preventDefault()
                      openMenu([
                        { label: 'Mark complete', icon: <Icon name="check" />, onSelect: () => onCheck(task, true) },
                        { label: 'Open source page', icon: <Icon name="file" />, onSelect: () => onOpen(task.pageId) },
                      ], event)
                    }}>
                      <label><input type="checkbox" className="home-task-check" checked={task.checked} onChange={event => onCheck(task, event.target.checked)} /><span className="ds-check" aria-hidden="true"><Icon name="check" size={12} /></span><span dir="auto">{task.text || t('Untitled')}</span></label>
                      <button type="button" className="home-task-source" onClick={() => onOpen(task.pageId)} aria-label={t('Open {page}', { page: byId.get(task.pageId)?.title || t('Untitled') })}><span dir="auto">{byId.get(task.pageId)?.title || t('Untitled')}</span></button>
                    </motion.div>
                  ))}</AnimatePresence></div> : <p className="home-note">{t('No open tasks. Checklist items from your pages appear here.')}</p>}
                </Section>
                <button type="button" className="home-review-link" onClick={onCards}>
                  <Icon name="cards" size={18} /><span><b>{t('Flashcards')}</b><small>{due === null ? t('Open flashcards') : due > 0 ? t('{n} ready to review', { n: num(due) }) : t('No cards due')}</small></span><Icon name="arrow-right" size={16} className="ds-flip" />
                </button>
                <details className="home-activity" open>
                  <summary><Icon name="calendar" size={16} /><span>{t('Writing activity')}</span><Icon name="chevron-down" size={14} /></summary>
                  <div className="home-activity-content">
                    <p>{t(streak === 1 ? '1 day in a row' : '{n} days in a row', { n: num(streak) })}</p>
                    <div className="home-activity-days" role="img" aria-label={t('{n} days edited in the last 4 weeks', { n: num(activity.filter(day => day.done).length) })}>
                      {activity.map(({ date, done }) => <span key={date.toISOString()} data-done={done} title={`${new Intl.DateTimeFormat(locale(), { dateStyle: 'long' }).format(date)} · ${t(done ? 'Edited' : 'No edits')}`} />)}
                    </div>
                    <small>{t('Last 4 weeks')}</small>
                  </div>
                </details>
              </aside>
            </div>
          </div>
        </>
      )}
      {menu}
    </div>
  )
}
