// Tasks, drawn as the old app drew them (tk-*, ds-list rows, the sources in the side panel). Every checklist item of every page; ticking a box
// writes the change into the page itself. (The old inbox and projects are not here yet: they have no place in the new data model.)
import { useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Checkbox, Icon, IconButton, Screen, contextMenuAnchor, useMenu, useUIMotion } from '../ds'
import { locale, t } from '../i18n'
import { go } from '../router'
import { legacyPages, legacyTasks } from '../shell/adapt'
import { PageContextMenu } from '../shell/pageContextMenu'
import { PanelHost } from '../shell/panelHost'
import { PageIcon } from '../shell/PageIcon'
import type { Page } from '../shell/model'
import type { Workspace } from '../workspace'

type Source = { kind: 'all' } | { kind: 'inbox' } | { kind: 'page'; id: string }
type Status = 'active' | 'done' | 'all'
const ALL: Source = { kind: 'all' }
const SETTLE_MS = 700

export function Tasks({ ws }: { ws: Workspace }) {
  const host = useContext(PanelHost)
  const pageMenu = useContext(PageContextMenu)
  const { open: openMenu, menu } = useMenu()
  const motionOf = useUIMotion()
  const [source, setSource] = useState<Source>(ALL)
  const [status, setStatus] = useState<Status>('all')
  const [showDone, setShowDone] = useState(false)
  const [settling, setSettling] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const pages = useMemo(() => new Map(legacyPages(ws, false).map(p => [p.id, p])), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const raw = ws.search.tasks().filter(x => x.task.text)
  const tasks = legacyTasks(ws).filter(x => x.text)
  const inboxId = ws.inboxId() ?? ''
  const items = tasks.map((x, i) => ({ key: `${x.pageId}:${x.index}`, text: x.text, checked: x.checked, page: pages.get(x.pageId), blockId: raw[i]?.task.blockId ?? '', pageId: x.pageId }))
  const num = (n: number) => n.toLocaleString(locale())
  const counts = new Map<string, number>()
  for (const x of items) if (!x.checked) counts.set(x.pageId, (counts.get(x.pageId) ?? 0) + 1)
  const withTasks = [...new Set(items.map(x => x.pageId))].filter(id => id !== inboxId).map(id => pages.get(id)).filter((p): p is Page => !!p)
  const lists = [...pages.values()].filter(p => p.kind === 'todo' && !p.deletedAt)
  const sources = withTasks.filter(p => p.kind !== 'todo')
  const page = source.kind === 'page' ? pages.get(source.id) : undefined
  const current: Source = source.kind === 'page' && !page ? ALL : source
  const shown = items.filter(x => current.kind === 'all' || (current.kind === 'inbox' ? x.pageId === inboxId : x.pageId === current.id))
  const canAdd = current.kind === 'all' || current.kind === 'inbox'
  const add = () => { const text = draft.trim(); if (!text) return; setDraft(''); void ws.ensureInbox().then(id => ws.appendTask(id, text)); input.current?.focus() }
  const newList = () => void ws.newTodoList(t('New list')).then(id => go({ name: 'page', id }))
  const open = shown.filter(x => !x.checked || settling.includes(x.key))
  const done = shown.filter(x => x.checked && !settling.includes(x.key))
  const total = shown.length
  const pct = total ? Math.round((shown.filter(x => x.checked).length / total) * 100) : 0
  const allOpen = items.filter(x => !x.checked).length
  const toggle = (x: (typeof items)[number], next: boolean) => {
    if (next) { setSettling(s => [...s, x.key]); window.setTimeout(() => setSettling(s => s.filter(k => k !== x.key)), SETTLE_MS) }
    void ws.setTaskChecked(x.pageId, x.blockId, next, items.filter(y => y.pageId === x.pageId).indexOf(x))
  }
  const row = (x: (typeof items)[number]) => (
    <motion.div key={x.key} className="ds-list-row tk-row" data-testid="task-row" data-done={x.checked || undefined} style={{ '--depth': 0 } as CSSProperties}
      onContextMenu={e => openMenu([
        { label: x.checked ? 'Mark incomplete' : 'Mark complete', icon: <Icon name={x.checked ? 'undo' : 'check'} />, onSelect: () => toggle(x, !x.checked) },
        { label: 'Open source page', icon: <Icon name="file" />, onSelect: () => go({ name: 'page', id: x.pageId }) },
        ...(x.pageId === inboxId ? [{ label: 'Delete', danger: true, icon: <Icon name="trash" />, onSelect: () => void ws.removeTask(x.pageId, x.blockId) }] : []),
      ], e)}
      layout={motionOf.reduced ? false : 'position'} initial={motionOf.reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={motionOf.reduced ? undefined : { opacity: 0, height: 0 }} transition={{ ...motionOf.transition, layout: motionOf.spring }}>
      <Checkbox checked={x.checked} onChange={next => toggle(x, next)} className="tk-check"><span className="tk-text" dir="auto">{x.text}</span></Checkbox>
      {x.pageId === inboxId && <IconButton label={t('Delete')} className="tk-del" onClick={() => void ws.removeTask(x.pageId, x.blockId)}><Icon name="trash" size={16} /></IconButton>}
      {current.kind === 'all' && <button type="button" className="tk-from" dir="auto" onClick={() => setSource(x.pageId === inboxId ? { kind: 'inbox' } : { kind: 'page', id: x.pageId })} title={t('Show only this list')}>{x.pageId === inboxId ? t('Inbox') : x.page?.title || t('Untitled')}</button>}
    </motion.div>
  )
  const sourceButton = (id: Source, icon: ReactNode, name: string, count: number) => (
    <button key={id.kind === 'page' ? id.id : id.kind} type="button" className="tk-source" aria-current={(current.kind === id.kind && (id.kind !== 'page' || (current.kind === 'page' && current.id === id.id))) || undefined} onClick={() => { setSource(id); setShowDone(false) }} onContextMenu={id.kind === 'page' && pageMenu ? e => pageMenu(id.id, contextMenuAnchor(e)) : undefined}>
      <span className="tk-source-ic">{icon}</span><span className="tk-source-name" dir="auto">{name}</span>{count > 0 && <span className="ds-badge">{num(count)}</span>}
    </button>
  )
  const sourcesNav = (
    <nav className="tk-sources" aria-label={t('Task lists')}>
      {sourceButton(ALL, <Icon name="checklist" size={17} />, t('All tasks'), allOpen)}
      {sourceButton({ kind: 'inbox' }, <Icon name="inbox" size={17} />, t('Inbox'), counts.get(inboxId) ?? 0)}
      <h2 className="tk-sources-title">{t('Lists')}</h2>
      {lists.map(p => sourceButton({ kind: 'page', id: p.id }, <PageIcon page={p} />, p.title || t('Untitled'), counts.get(p.id) ?? 0))}
      <button type="button" className="tk-source tk-source-new" data-testid="new-list" onClick={newList}><span className="tk-source-ic"><Icon name="plus" size={16} /></span><span className="tk-source-name">{t('New list')}</span></button>
      {sources.length > 0 && <h2 className="tk-sources-title">{t('In pages')}</h2>}
      {sources.map(p => sourceButton({ kind: 'page', id: p.id }, <PageIcon page={p} />, p.title || t('Untitled'), counts.get(p.id) ?? 0))}
    </nav>
  )
  const title = current.kind === 'all' ? t('All tasks') : current.kind === 'inbox' ? t('Inbox') : page?.title || t('Untitled')
  return (
    <Screen width="wide" title={t('Tasks')} description={allOpen ? t('{n} open across your pages and inbox', { n: num(allOpen) }) : t('Checklist items from all your pages appear here.')}>
      <div className="tk" data-testid="tasks">
        {host && createPortal(sourcesNav, host)}
        <section className="tk-main" aria-labelledby="tk-title">
          <header className="tk-main-head">
            <div className="tk-main-title"><h2 id="tk-title" dir="auto">{title}</h2><p>{total ? t('{done} of {total} done', { done: num(shown.filter(x => x.checked).length), total: num(total) }) : t('Nothing here yet')}</p></div>
            {page && <Button variant="ghost" size="sm" icon={<Icon name="arrow-up-right" size={15} className="ds-flip" />} onClick={() => go({ name: 'page', id: page.id })}>{t('Open page')}</Button>}
          </header>
          {total > 0 && <div className="ds-progress tk-progress" role="progressbar" aria-label={t('Tasks done')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ inlineSize: pct + '%' }} /></div>}
          {canAdd && (
            <form className="tk-add" onSubmit={e => { e.preventDefault(); add() }}>
              <Icon name="plus" size={18} />
              <input ref={input} data-testid="task-add" value={draft} onChange={e => setDraft(e.target.value)} placeholder={t('Add a task to your inbox')} aria-label={t('New task')} dir="auto" autoComplete="off" />
              {draft.trim() && <kbd className="ds-kbd">{t('Enter')}</kbd>}
            </form>
          )}
          <div className="tk-status" role="group" aria-label={t('Task status')}>
            {(['active', 'done', 'all'] as const).map(v => <Button key={v} size="sm" variant="ghost" aria-pressed={status === v} onClick={() => setStatus(v)}>{t(v === 'active' ? 'Active' : v === 'done' ? 'Done' : 'All')}</Button>)}
          </div>
          {status !== 'done' && (open.length > 0 ? <div className="ds-list ds-list--framed tk-list"><AnimatePresence initial={false}>{open.map(row)}</AnimatePresence></div> : (
            <div className="ds-empty ds-empty--framed" data-testid="tasks-empty"><Icon name={total ? 'check-circle' : 'checklist'} /><b>{total ? t('All caught up') : t('No tasks here yet')}</b><span>{total ? t('Every task here is done') : canAdd ? t('Type one above, or add a checklist to any page with /todo') : t('Open the page and add a checklist with /todo')}</span></div>
          ))}
          {status === 'done' && (done.length ? <div className="ds-list ds-list--framed tk-list"><AnimatePresence initial={false}>{done.map(row)}</AnimatePresence></div> : <div className="ds-empty ds-empty--framed"><b>{t('No completed tasks')}</b></div>)}
          {status === 'all' && done.length > 0 && (
            <div className="tk-done">
              <button type="button" className="tk-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(v => !v)}><Icon name="chevron-right" size={15} className="tk-done-chev ds-flip" />{t('Completed')}<span className="ds-badge">{num(done.length)}</span></button>
              <AnimatePresence initial={false}>{showDone && <motion.div key="done" className="tk-done-body" initial={motionOf.reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={motionOf.reduced ? undefined : { opacity: 0, height: 0 }} transition={motionOf.transition}><div className="ds-list ds-list--framed tk-list"><AnimatePresence initial={false}>{done.map(row)}</AnimatePresence></div></motion.div>}</AnimatePresence>
            </div>
          )}
        </section>
      </div>
      {menu}
    </Screen>
  )
}
