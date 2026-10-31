import { useEffect, useMemo, useState } from 'react'
import { repo } from './store'
import { PageIcon } from './PageIcon'
import { allTasks, loadInbox, saveInbox, setChecked, type InboxTask, type Task } from './taskData'
import { t } from './i18n'
import { firstTextDirection } from './textDirection'
import * as Ic from './icons'

type Filter = 'open' | 'done' | 'all'

/** Every checklist item of every page in one place. Ticking a box here changes the page itself. */
export function Tasks({ onOpen, onNewList }: { onOpen: (id: string) => void; onNewList: () => void }) {
  const [tick, setTick] = useState(0)
  const [filter, setFilter] = useState<Filter>('open')
  const [draft, setDraft] = useState('')
  const [inbox, setInbox] = useState<InboxTask[]>([])
  useEffect(() => void loadInbox().then(setInbox), [])
  const editInbox = (next: InboxTask[]) => (setInbox(next), void saveInbox(next))
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasks = useMemo(allTasks, [tick])
  const inboxDone = inbox.filter((x) => x.checked).length
  const total = tasks.length + inbox.length
  const open = tasks.filter((x) => !x.checked).length + inbox.length - inboxDone
  const pct = total ? Math.round(((total - open) / total) * 100) : 0
  const shown = tasks.filter((x) => x.text && (filter === 'all' || (filter === 'done') === x.checked))
  const groups = new Map<string, Task[]>()
  for (const x of shown) groups.set(x.pageId, [...(groups.get(x.pageId) ?? []), x])
  // stand-alone to-do lists first, then checklists that live inside ordinary pages
  const isList = (id: string) => repo.get(id)?.kind === 'todo'
  const listGroups = [...groups].filter(([id]) => isList(id))
  const pageGroups = [...groups].filter(([id]) => !isList(id))
  const lists = useMemo(
    () => repo.pagesOnly().filter((p) => p.kind === 'todo').map((p) => ({ page: p, all: tasks.filter((x) => x.pageId === p.id && x.text) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks],
  )

  const add = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    editInbox([...inbox, { id: crypto.randomUUID(), text, checked: false }])
  }
  const inboxShown = inbox.filter((x) => filter === 'all' || (filter === 'done') === x.checked)

  return (
    <div className="tk">
      <header className="tk-head">
        <h1>{t('Tasks')}</h1>
        <p>{total ? t('{open} open · {done} done', { open, done: total - open }) : t('Checklist items from all your pages appear here.')}</p>
        {total > 0 && <div className="tk-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: pct + '%' }} /></div>}
      </header>

      <form className="tk-add" dir={firstTextDirection(draft) ?? 'auto'} onSubmit={(e) => (e.preventDefault(), add())}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('Add a task…')} dir="auto" />
        <button className="ds-btn ds-btn--primary" type="submit" disabled={!draft.trim()}><Ic.Plus size={16} />{t('Add')}</button>
      </form>

      <div className="dw-tools">
        <div className="ds-seg" role="tablist">
          {(['open', 'done', 'all'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} aria-pressed={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'open' ? t('Active') : f === 'done' ? t('Done') : t('All')}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="ds-btn ds-btn--primary" onClick={onNewList}><Ic.Plus size={15} />{t('New list')}</button>
      </div>

      {lists.length > 0 && (
        <section className="tk-group">
          <div className="tk-label">{t('To-do lists')}</div>
          {lists.map(({ page, all }) => (
            <button key={page.id} className="tk-page" onClick={() => onOpen(page.id)}>
              <span className="hm-row-ic"><PageIcon page={page} /></span>
              <b dir="auto">{page.title || t('Untitled')}</b>
              <small>{all.filter((x) => x.checked).length}/{all.length}</small>
            </button>
          ))}
        </section>
      )}

      {inboxShown.length > 0 && (
        <section className="tk-group">
          <div className="tk-page static"><span className="hm-row-ic"><Ic.Checklist size={16} /></span><b>{t('Inbox')}</b><small>{inboxShown.length}</small></div>
          {inboxShown.map((x) => (
            <div key={x.id} className={'tk-item' + (x.checked ? ' done' : '')} dir={firstTextDirection(x.text) ?? 'auto'}>
              <input type="checkbox" checked={x.checked} onChange={(e) => editInbox(inbox.map((y) => (y.id === x.id ? { ...y, checked: e.target.checked } : y)))} />
              <input className="tk-text" dir="auto" value={x.text} onChange={(e) => editInbox(inbox.map((y) => (y.id === x.id ? { ...y, text: e.target.value } : y)))} onBlur={() => !x.text.trim() && editInbox(inbox.filter((y) => y.id !== x.id))} />
              <button className="tk-del" title={t('Delete')} onClick={() => editInbox(inbox.filter((y) => y.id !== x.id))}><Ic.Close size={14} /></button>
            </div>
          ))}
        </section>
      )}
      {inboxShown.length > 0 && groups.size > 0 && <hr className="tk-sep" />}

      {groups.size === 0 && inboxShown.length === 0 ? (
        <div className="ds-empty ds-card"><b>{filter === 'open' && tasks.length ? t('All caught up') : t('No tasks here')}</b></div>
      ) : (
        [...listGroups, ...pageGroups].map(([pageId, items], i) => {
          const page = repo.get(pageId)!
          const head = i === 0 && listGroups.length ? t('In lists') : i === listGroups.length && pageGroups.length ? t('In pages') : ''
          return (
            <section key={pageId} className="tk-group">
              {head && <div className="tk-label">{head}</div>}
              <button className="tk-page" onClick={() => onOpen(pageId)}>
                <span className="hm-row-ic"><PageIcon page={page} /></span>
                <b dir="auto">{page.title || t('Untitled')}</b>
                <small>{items.length}</small>
              </button>
              {items.map((x) => (
                <label key={x.index} className={'tk-item' + (x.checked ? ' done' : '')} dir={firstTextDirection(x.text) ?? 'auto'} style={{ paddingInlineStart: 6 + x.depth * 22 }}>
                  <input type="checkbox" checked={x.checked} onChange={(e) => (setChecked(x, e.target.checked), setTick((n) => n + 1))} />
                  <span dir="auto">{x.text}</span>
                </label>
              ))}
            </section>
          )
        })
      )}
    </div>
  )
}
