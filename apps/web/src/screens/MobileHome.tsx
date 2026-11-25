import { useMemo, useState } from 'react'
import type { Page, Task } from '../shell/model'
import { Checkbox, Icon } from '../ds'
import { PageIcon } from '../shell/PageIcon'
import { ago } from '../shell/ago'
import { t } from '../i18n'
import { excerpt } from './HomeScreen'
import { HomeNote } from './HomeNote'
import type { Workspace } from '../workspace'

/** Phone home keeps the user's actual documents and draft close to the writing action. */
export function MobileHome({ ws, pages, tasks, due, showIcons, onCheck, onOpen, onNew, onAll, onTemplates, onImport, onFiles, onTasks, onCards }: {
  ws: Workspace; pages: Page[]; tasks: Task[]; due: number | null; showIcons: boolean; onCheck: (task: Task, checked: boolean) => void; onOpen: (id: string) => void; onNew: () => void
  onAll: () => void; onTemplates: () => void; onImport: () => void; onFiles: () => void; onTasks: () => void; onCards: () => void
}) {
  const [quickOpen, setQuickOpen] = useState(false)
  const documents = useMemo(() => pages.filter(page => !page.deletedAt && page.kind !== 'folder' && !page.database).sort((a, b) => b.updatedAt - a.updatedAt), [pages])
  const latest = documents[0]
  const recent = documents.slice(1, 5)
  const pendingTasks = tasks.filter(task => !task.checked)
  const openTasks = pendingTasks.length
  const favorites = documents.filter(page => page.favorite).slice(0, 3)
  const title = (page: Page) => page.title || t('Untitled')
  const dateTime = (value: number) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined
  return <div className="mobile-home" data-testid="mobile-home">
    <header className="mobile-home-head">
      <div><h1>{t('Your notes')}</h1>{documents.length > 0 && <p>{t('Keep writing from where you stopped.')}</p>}</div>
      <button type="button" className="mobile-home-new" data-testid="mobile-home-new" onClick={onNew}><Icon name="plus" size={18} /><span>{t('New page')}</span></button>
    </header>
    <section className="mobile-home-writing" aria-label={t('Quick note')}>
      <button className="mobile-home-quick" type="button" aria-expanded={quickOpen} aria-controls="mobile-home-composer" data-testid="mobile-home-quick" onClick={() => setQuickOpen(open => !open)}>
        <span className="mobile-home-quick-icon"><Icon name="pencil" size={18} /></span>
        <span><b>{t('Write a quick note')}</b><small>{t('Saved as you write')}</small></span>
        <Icon name="chevron-down" size={17} className={quickOpen ? 'mobile-home-chevron-open' : ''} />
      </button>
      <div id="mobile-home-composer" className="mobile-home-composer" hidden={!quickOpen}><HomeNote ws={ws} onOpen={onOpen} /></div>
    </section>
    {latest ? <section className="mobile-home-recent" aria-label={t('Recent pages')}>
      <div className="mobile-home-section-head"><h2>{t('Continue writing')}</h2><button type="button" onClick={onAll}>{t('View all')}</button></div>
      <button type="button" className="mobile-home-latest" data-testid="mobile-home-latest" onClick={() => onOpen(latest.id)}>
        {showIcons && <span className="mobile-home-latest-mark"><PageIcon page={latest} /></span>}
        <span className="mobile-home-latest-body"><b dir="auto">{title(latest)}</b>{excerpt(latest.content) && <small dir="auto">{excerpt(latest.content)}</small>}<time dateTime={dateTime(latest.updatedAt)}>{ago(latest.updatedAt)}</time></span>
        <Icon name="arrow-right" size={16} className="ds-flip" />
      </button>
      {recent.length > 0 && <div className="mobile-home-list">{recent.map(page => <button type="button" className="mobile-home-row" data-testid="mobile-home-row" key={page.id} onClick={() => onOpen(page.id)}>
        {showIcons && <PageIcon page={page} />}<span className="mobile-home-row-body"><b dir="auto">{title(page)}</b>{excerpt(page.content) && <small dir="auto">{excerpt(page.content)}</small>}</span><time dateTime={dateTime(page.updatedAt)}>{ago(page.updatedAt)}</time>
      </button>)}</div>}
    </section> : <section className="mobile-home-empty" data-testid="mobile-home-empty"><Icon name="file" size={20} /><span>{t('Create a page or write a quick note to get started.')}</span></section>}
    {favorites.length > 0 && <section className="mobile-home-favorites" aria-label={t('Favorites')}>
      <h2>{t('Favorites')}</h2><div>{favorites.map(page => <button type="button" key={page.id} onClick={() => onOpen(page.id)}><Icon name="star" size={14} /><span dir="auto">{title(page)}</span></button>)}</div>
    </section>}
    {pendingTasks.length > 0 && <section className="mobile-home-tasks" aria-label={t('Open tasks')}>
      <div className="mobile-home-section-head"><h2>{t('Open tasks')}</h2><button type="button" onClick={onTasks}>{t('View all')}</button></div>
      {pendingTasks.slice(0, 2).map(task => <div className="mobile-home-task" key={`${task.pageId}:${task.index}`}>
        <Checkbox checked={false} onChange={checked => onCheck(task, checked)}><span dir="auto">{task.text || t('Untitled')}</span></Checkbox>
        <button type="button" onClick={() => onOpen(task.pageId)} aria-label={t('Open source page')}><Icon name="arrow-right" size={16} className="ds-flip" /></button>
      </div>)}
    </section>}
    <section className="mobile-home-links" aria-label={t('Workspace tools')}>
      <button type="button" onClick={onTemplates}><Icon name="templates" size={18} /><span>{t('Templates')}</span><Icon name="chevron-right" size={16} className="ds-flip" /></button>
      <button type="button" onClick={onTasks}><Icon name="tasks" size={18} /><span>{t('Open tasks')}</span>{openTasks > 0 && <small>{openTasks.toLocaleString()}</small>}<Icon name="chevron-right" size={16} className="ds-flip" /></button>
      <button type="button" onClick={onCards}><Icon name="cards" size={18} /><span>{t('Flashcards')}</span>{due !== null && due > 0 && <small>{due.toLocaleString()}</small>}<Icon name="chevron-right" size={16} className="ds-flip" /></button>
      <button type="button" onClick={onFiles}><Icon name="paperclip" size={18} /><span>{t('Files')}</span><Icon name="chevron-right" size={16} className="ds-flip" /></button>
      {!latest && <button type="button" onClick={onImport}><Icon name="upload" size={18} /><span>{t('Import notes')}</span><Icon name="chevron-right" size={16} className="ds-flip" /></button>}
    </section>
  </div>
}
