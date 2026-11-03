import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { HomeScreen } from '../../HomeScreen'
import { HomeNote } from '../../HomeNote'
import { getTemplates } from '../../templates'
import { Button, Icon, WorkspaceHeader } from '../../design-system'
import { BrandMark } from '../../BrandMark'
import { updateSettings } from '../../settings'
import { tasksOf } from '../../taskData'
import { t } from '../../i18n'
import type { Page } from '../../repo'
import '../../index.css'
import './preview.css'

// Isolated, in-memory review data. No store initialization or native vault access.
const query = new URLSearchParams(location.search)
updateSettings({ lang: query.get('lang') === 'fa' ? 'fa' : 'en', dir: 'auto', theme: query.get('theme') === 'dark' ? 'dark' : 'light', accent: query.get('accent'), sidebar: 'default', fontEn: query.has('mono') ? 'mono' : null, reduceMotion: query.has('reduced') })
const now = Date.now()
const labels = [
  ['Research notes', 'Observations from the interviews, references, and questions for the next session.'],
  ['یادداشت‌های طراحی', 'ساختار صفحه‌ها، فاصله‌گذاری و نکته‌های جلسهٔ امروز تیم طراحی.'],
  ['Reading list', 'Essays, books, and a few things to come back to this week.'],
  ['Project planning — a longer title to check how the page behaves', 'Scope, next steps, and decisions from our last discussion.'],
  ['مرور فصل سوم', 'نکته‌های کلیدی فصل سوم و پرسش‌هایی برای مرور بعدی.'],
  ['Meeting notes', 'Agenda and follow-up from the weekly project meeting.'],
]
const initial: Page[] = labels.map(([title, text], i) => ({
  id: `preview-${i}`, title, parentId: null, favorite: i < 3, sort: i, deletedAt: null,
  cover: i === 1 ? { kind: 'gradient', id: 'ds-rose-mountain' } : undefined,
  updatedAt: now - i * 86400000,
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...(i < 3 ? [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: ['Prepare interview questions', 'بررسی نسخهٔ جدید صفحهٔ هوم', 'Read the next chapter'][i] }] }] }] }] : [])] },
}))

function Preview() {
  const draftId = useRef<string | null>(null)
  const [pages, setPages] = useState(query.get('state') === 'empty' ? [] : query.get('state') === 'single' ? initial.slice(0, 1) : initial)
  const [action, setAction] = useState('')
  const show = (text: string) => setAction(text)
  return <div className="app">
    <aside className="side home-preview-side">
      <WorkspaceHeader mark={<BrandMark />} name="Nevis" />
      <Button variant="ghost" icon={<Icon name="search" />} onClick={() => show('Search')}>{t('Search')}</Button>
      <Button variant="ghost" className="home-preview-selected" icon={<Icon name="home" />} onClick={() => setAction('')}>{t('Home')}</Button>
      <Button variant="ghost" icon={<Icon name="file" />} onClick={() => show('Pages')}>{t('Pages')}</Button>
      <div className="home-preview-tree">{pages.map(p => <Button key={p.id} variant="ghost" onClick={() => show(p.title)}><span dir="auto">{p.title}</span></Button>)}</div>
      <Button variant="ghost" icon={<Icon name="settings" />} onClick={() => show('Settings')}>{t('Settings')}</Button>
    </aside>
    <main className="main"><header className="topbar"><Icon name="arrow-left" /><Icon name="arrow-right" /><Icon name="home" /><span>{t('Home')}</span></header><div className="scroller"><HomeScreen pages={pages} tasks={pages.flatMap(p => tasksOf(p.id, p.content))} due={pages.length ? 8 : 0} now={now} showIcons={!query.has('noicons')} draftId={draftId.current}
      onOpen={id => show(`Opened ${id}`)} onNew={() => { setPages([...pages, { ...initial[0], id: crypto.randomUUID(), title: t('Untitled'), content: { type: 'doc', content: [] }, updatedAt: Date.now(), favorite: false }]); show('New page') }}
      onTable={() => show('All pages')} onCards={() => show('Flashcards')} onTemplates={() => show('Templates')} onTemplate={id => show(getTemplates().find(template => template.id === id)?.title || id)} onImport={() => show(t('Import notes'))} onFiles={() => show('Files')} onTasks={() => show('Tasks')}
      note={<HomeNote onOpen={id => show(`Opened ${id}`)} onPersist={async () => undefined} onChange={draft => {
        if (!draftId.current) draftId.current = crypto.randomUUID()
        const id = draftId.current
        const page = { ...initial[0], id, title: draft.title.trim() || draft.text.split('\n')[0].slice(0, 80), content: draft.content, favorite: false, updatedAt: Date.now() }
        setPages(pages => pages.some(p => p.id === id) ? pages.map(p => p.id === id ? page : p) : [page, ...pages])
        return id
      }} />}
      onCheck={task => setPages(pages.map(p => p.id !== task.pageId ? p : { ...p, content: { type: 'doc', content: p.content.content.filter((n: { type: string }) => n.type !== 'taskList') } }))} />
    </div>{action && <output className="home-preview-feedback" aria-live="polite">{action}</output>}</main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
