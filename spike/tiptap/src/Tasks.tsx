import { createPortal } from 'react-dom'
import type { PageIndex } from './pageIndex'
import { buildTaskProjects } from './taskProjects'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { repo } from './store'
import { PageIcon } from './PageIcon'
import type { Page } from './repo'
import { Button, Checkbox, Icon, IconButton, Screen, useUIMotion } from './design-system'
import { allTasks, loadInbox, saveInbox, setChecked, type InboxTask, type Task } from './taskData'
import { showToast } from './ui'
import { t, locale } from './i18n'

/** What the right-hand pane shows: everything, the inbox, or the tasks of one page. */
type Source = { kind: 'all' | 'inbox' } | { kind: 'page' | 'project'; id: string }

const ALL_TASKS: Source = { kind: 'all' }
const sameSource = (a: Source, b: Source) => a.kind === b.kind && (!('id' in a) || ('id' in b && a.id === b.id))
type Status = 'active' | 'done' | 'all'

/** How long a ticked task stays among the open ones, so the tick is seen before the row moves to Completed. */
const SETTLE_MS = 700

const keyOf = (x: Task) => `${x.pageId}:${x.index}`

/** One task as the list draws it: a checklist item of a page, or an inbox item. */
interface Item {
  key: string
  text: string
  checked: boolean
  depth: number
  page?: Page
  task?: Task
  inbox?: InboxTask
}

/**
 * Tasks: every checklist item of every page, plus an inbox for tasks typed here. On one side the sources (all, inbox,
 * your to-do lists, the pages that have checklists) with what is still open; on the other the chosen source's open
 * tasks, and its completed ones folded away underneath. Ticking a box here changes the page itself.
 */
export function Tasks({ panelHost, index, onOpen, onNewList }: { panelHost: HTMLElement | null; index: PageIndex; onOpen: (id: string) => void; onNewList: () => void }) {
  const motionOf = useUIMotion()
  const [tick, setTick] = useState(0)
  const [source, setSource] = useState<Source>(ALL_TASKS)
  const [status, setStatus] = useState<Status>('all')
  const [showDone, setShowDone] = useState(false)
  const [draft, setDraft] = useState('')
  const [inbox, setInbox] = useState<InboxTask[]>([])
  const [settling, setSettling] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => void loadInbox().then(setInbox), [])
  const editInbox = (next: InboxTask[]) => (setInbox(next), void saveInbox(next))
  /** Deletes an inbox task; the toast's Undo (or Ctrl+Z) puts it back where it was. */
  const remove = (task: InboxTask) => {
    const at = inbox.findIndex((y) => y.id === task.id)
    editInbox(inbox.filter((y) => y.id !== task.id))
    showToast(t('Task deleted'), () =>
      setInbox((cur) => {
        const next = [...cur.slice(0, at), task, ...cur.slice(at)]
        void saveInbox(next)
        return next
      }),
    )
  }
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => allTasks().filter((x) => x.text), [tick])
  const num = (n: number) => n.toLocaleString(locale())

  const items = useMemo(() => {
    const fromPages: Item[] = tasks.map((x) => ({ key: keyOf(x), text: x.text, checked: x.checked, depth: x.depth, page: repo.get(x.pageId), task: x }))
    const fromInbox: Item[] = inbox.map((x) => ({ key: x.id, text: x.text, checked: x.checked, depth: 0, inbox: x }))
    return [...fromInbox, ...fromPages]
  }, [tasks, inbox])

  // the sources: to-do lists first (even empty ones), then ordinary pages that have checklists
  const sources = useMemo(() => {
    const pages = new Map<string, Page>()
    for (const p of repo.pagesOnly()) if (p.kind === 'todo') pages.set(p.id, p)
    for (const x of tasks) {
      const p = repo.get(x.pageId)
      if (p) pages.set(p.id, p)
    }
    const counts = new Map<string, number>()
    for (const task of tasks) if (!task.checked) counts.set(task.pageId, (counts.get(task.pageId) ?? 0) + 1)
    const all = [...pages.values()].map((page) => ({ page, open: counts.get(page.id) ?? 0 }))
    return { lists: all.filter((s) => s.page.kind === 'todo'), pages: all.filter((s) => s.page.kind !== 'todo') }
  }, [tasks])
  const { projects, projectByPage } = useMemo(() => buildTaskProjects(index, tasks), [index, tasks])
  // A removed source falls back to the workspace view.
  const project = source.kind === 'project' ? projects.find(({ folder }) => folder.id === source.id) : undefined
  const page = source.kind === 'page' ? [...sources.lists, ...sources.pages].find(({ page }) => page.id === source.id)?.page : undefined
  const current = (source.kind === 'project' && !project) || (source.kind === 'page' && !page) ? ALL_TASKS : source
  const aggregate = current.kind === 'all' || current.kind === 'project'
  const shown = items.filter((item) => {
    switch (current.kind) {
      case 'all':
        return true
      case 'inbox':
        return !!item.inbox
      case 'page':
        return item.page?.id === current.id
      case 'project':
        return !!item.page && projectByPage.get(item.page.id) === current.id
    }
  })
  const open = shown.filter((x) => !x.checked || settling.includes(x.key))
  const done = shown.filter((x) => x.checked && !settling.includes(x.key))
  const total = shown.length
  const pct = total ? Math.round((shown.filter((x) => x.checked).length / total) * 100) : 0
  const canAdd = current.kind === 'all' || current.kind === 'inbox'
  const pickSource = (next: Source) => {
    setSource(next)
    setShowDone(false)
  }

  const toggle = (x: Item, next: boolean) => {
    if (next) {
      setSettling((s) => [...s, x.key])
      window.setTimeout(() => setSettling((s) => s.filter((k) => k !== x.key)), SETTLE_MS)
    }
    if (x.inbox) editInbox(inbox.map((y) => (y.id === x.key ? { ...y, checked: next } : y)))
    else if (x.task) (setChecked(x.task, next), setTick((n) => n + 1))
  }
  const add = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    editInbox([...inbox, { id: crypto.randomUUID(), text, checked: false }])
    input.current?.focus()
  }

  const row = (x: Item) => (
    <motion.div
      key={x.key}
      className="ds-list-row tk-row"
      data-done={x.checked || undefined}
      style={{ '--depth': aggregate ? 0 : x.depth } as CSSProperties}
      layout={motionOf.reduced ? false : 'position'}
      initial={motionOf.reduced ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={motionOf.reduced ? undefined : { opacity: 0, height: 0 }}
      transition={{ ...motionOf.transition, layout: motionOf.spring }}
    >
      {x.inbox ? (
        <>
          <Checkbox checked={x.checked} label={x.text} onChange={(next) => toggle(x, next)} />
          <input
            className="tk-text tk-edit"
            dir="auto"
            value={x.text}
            aria-label={t('Task')}
            onChange={(e) => editInbox(inbox.map((y) => (y.id === x.key ? { ...y, text: e.target.value } : y)))}
            onBlur={() => !x.text.trim() && editInbox(inbox.filter((y) => y.id !== x.key))}
          />
          <IconButton label={t('Delete')} className="tk-del" onClick={() => remove(x.inbox!)}>
            <Icon name="trash" size={16} />
          </IconButton>
        </>
      ) : (
        <Checkbox checked={x.checked} onChange={(next) => toggle(x, next)} className="tk-check">
          <span className="tk-text" dir="auto">
            {x.text}
          </span>
        </Checkbox>
      )}
      {aggregate && (
        <button type="button" className="tk-from" dir="auto" onClick={() => pickSource(x.page ? { kind: 'page', id: x.page.id } : { kind: 'inbox' })} title={t('Show only this list')}>
          {x.page ? x.page.title || t('Untitled') : t('Inbox')}
        </button>
      )}
    </motion.div>
  )

  const sourceButton = (id: Source, icon: ReactNode, name: string, count: number) => (
    <button key={'id' in id ? id.kind + ':' + id.id : id.kind} type="button" className="tk-source" aria-current={sameSource(current, id) || undefined} onClick={() => pickSource(id)}>
      <span className="tk-source-ic">{icon}</span>
      <span className="tk-source-name" dir="auto">
        {name}
      </span>
      {count > 0 && <span className="ds-badge">{num(count)}</span>}
    </button>
  )

  const title = current.kind === 'all' ? t('All tasks') : current.kind === 'inbox' ? t('Inbox') : project?.folder.title || page?.title || t('Untitled')
  const allOpen = items.filter((x) => !x.checked).length

  const sourcesNav = (
    <nav className="tk-sources" aria-label={t('Task lists')}>
      {sourceButton(ALL_TASKS, <Icon name="checklist" size={17} />, t('All tasks'), allOpen)}
      {sourceButton({ kind: 'inbox' }, <Icon name="inbox" size={17} />, t('Inbox'), inbox.filter((x) => !x.checked).length)}
      {projects.length > 0 && (
        <>
          <h2 className="tk-sources-title">{t('Projects')}</h2>
          {projects.map(({ folder, open }) => sourceButton({ kind: 'project', id: folder.id }, <PageIcon page={folder} />, folder.title || t('Untitled folder'), open))}
        </>
      )}
      <h2 className="tk-sources-title">{t('Lists')}</h2>
      {sources.lists.map((s) => sourceButton({ kind: 'page', id: s.page.id }, <PageIcon page={s.page} />, s.page.title || t('Untitled'), s.open))}
      <button type="button" className="tk-source tk-source-new" onClick={onNewList}>
        <span className="tk-source-ic">
          <Icon name="plus" size={16} />
        </span>
        <span className="tk-source-name">{t('New list')}</span>
      </button>
      {sources.pages.length > 0 && (
        <>
          <h2 className="tk-sources-title">{t('In pages')}</h2>
          {sources.pages.map((s) => sourceButton({ kind: 'page', id: s.page.id }, <PageIcon page={s.page} />, s.page.title || t('Untitled'), s.open))}
        </>
      )}
    </nav>
  )

  return (
    <Screen width="wide" title={t('Tasks')} description={allOpen ? t('{n} open across your pages and inbox', { n: num(allOpen) }) : t('Checklist items from all your pages appear here.')}>
      <div className="tk">
        {panelHost && createPortal(sourcesNav, panelHost)}

        <section className="tk-main" aria-labelledby="tk-title">
          <header className="tk-main-head">
            <div className="tk-main-title">
              <h2 id="tk-title" dir="auto">
                {title}
              </h2>
              <p>{total ? t('{done} of {total} done', { done: num(shown.filter((x) => x.checked).length), total: num(total) }) : t('Nothing here yet')}</p>
            </div>
            {page && (
              <Button variant="ghost" size="sm" icon={<Icon name="arrow-up-right" size={15} className="ds-flip" />} onClick={() => onOpen(page.id)}>
                {t('Open page')}
              </Button>
            )}
          </header>
          {total > 0 && (
            <div className="ds-progress tk-progress" role="progressbar" aria-label={t('Tasks done')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ inlineSize: pct + '%' }} />
            </div>
          )}

          {canAdd && (
            <form className="tk-add" onSubmit={(e) => (e.preventDefault(), add())}>
              <Icon name="plus" size={18} />
              <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('Add a task to your inbox')} aria-label={t('New task')} dir="auto" autoComplete="off" />
              {draft.trim() && <kbd className="ds-kbd">{t('Enter')}</kbd>}
            </form>
          )}

          <div className="tk-status" role="group" aria-label={t('Task status')}>
            {(['active', 'done', 'all'] as const).map((value) => (
              <Button key={value} size="sm" variant="ghost" aria-pressed={status === value} onClick={() => setStatus(value)}>
                {t(value === 'active' ? 'Active' : value === 'done' ? 'Done' : 'All')}
              </Button>
            ))}
          </div>
          {status !== 'done' &&
            (open.length > 0 ? (
              <div className="ds-list ds-list--framed tk-list">
                <AnimatePresence initial={false}>{open.map(row)}</AnimatePresence>
              </div>
            ) : (
              <div className="ds-empty ds-empty--framed">
                <Icon name={total ? 'check-circle' : 'checklist'} />
                <b>{total ? t('All caught up') : t('No tasks here yet')}</b>
                <span>{total ? t('Every task here is done') : canAdd ? t('Type one above, or add a checklist to any page with /todo') : t('Open the page and add a checklist with /todo')}</span>
              </div>
            ))}
          {status === 'done' &&
            (done.length ? (
              <div className="ds-list ds-list--framed tk-list">
                <AnimatePresence initial={false}>{done.map(row)}</AnimatePresence>
              </div>
            ) : (
              <div className="ds-empty ds-empty--framed">
                <b>{t('No completed tasks')}</b>
              </div>
            ))}

          {status === 'all' && done.length > 0 && (
            <div className="tk-done">
              <button type="button" className="tk-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                <Icon name="chevron-right" size={15} className="tk-done-chev ds-flip" />
                {t('Completed')}
                <span className="ds-badge">{num(done.length)}</span>
              </button>
              <AnimatePresence initial={false}>
                {showDone && (
                  <motion.div
                    key="done"
                    className="tk-done-body"
                    initial={motionOf.reduced ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={motionOf.reduced ? undefined : { opacity: 0, height: 0 }}
                    transition={motionOf.transition}
                  >
                    <div className="ds-list ds-list--framed tk-list">
                      <AnimatePresence initial={false}>{done.map(row)}</AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </section>
      </div>
    </Screen>
  )
}
