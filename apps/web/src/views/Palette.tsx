import { useEffect, useState, type ReactNode } from 'react'
import { normalizeFa } from '@nevis/editor'
import { Icon, SearchPalette, type PaletteSection } from '../ds'
import { go, type Route } from '../router'
import { t } from '../i18n'
import { SETTINGS_TABS } from '../settings/settingsTabs'
import type { Workspace } from '../workspace'

export interface SearchCommand {
  id: string
  label: string
  group: string
  icon?: ReactNode
  keywords?: string
  hint?: string
  searchOnly?: boolean
  run: () => void
}

const destinations = [
  ['home', 'Home', 'home', 'dashboard خانه'],
  ['all', 'All pages', 'table', 'documents pages list همه صفحه'],
  ['templates', 'Templates', 'templates', 'template قالب الگو'],
  ['tasks', 'Tasks', 'checklist', 'tasks todo checklist کارها وظایف'],
  ['cards', 'Flashcards', 'cards', 'review cards مرور فلش کارت'],
  ['databases', 'Databases', 'database', 'database table دیتابیس پایگاه داده جدول'],
  ['drawings', 'Drawings', 'pencil', 'whiteboard canvas sketch نقاشی بوم طراحی'],
  ['graph', 'Graph', 'graph', 'link map backlinks گراف نقشه پیوند'],
  ['files', 'Files', 'paperclip', 'file explorer folders مدیریت فایل پوشه'],
  ['trash', 'Trash', 'trash', 'deleted recycle bin سطل حذف شده'],
] as const satisfies readonly [Route['name'], string, string, string][]

const wordsOf = (value: string) => normalizeFa(value).trim().split(/\s+/).filter(Boolean)
const matches = (words: string[], value: string) => {
  const normalized = normalizeFa(value)
  return words.every(word => normalized.includes(word))
}

type PageResult = { term: string; ids: string[]; failed?: boolean }

export function Palette({ ws, commands, onOpen, onClose }: {
  ws: Workspace
  commands: SearchCommand[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [result, setResult] = useState<PageResult>()
  const [retry, setRetry] = useState(0)
  const prefixed = query.trimStart().startsWith('>')
  const commandsOnly = prefixed || scope === 'commands'
  const term = (prefixed ? query.trimStart().slice(1) : query).trim()
  const words = wordsOf(term)
  const ready = ws.search.ready

  useEffect(() => {
    if (!term || commandsOnly || !ready) return
    let live = true
    const timer = window.setTimeout(() => {
      void ws.search.search(term, 20).then(
        hits => { if (live) setResult({ term, ids: hits.map(hit => hit.id) }) },
        () => { if (live) setResult({ term, ids: [], failed: true }) },
      )
    }, 60)
    return () => { live = false; window.clearTimeout(timer) }
  }, [term, commandsOnly, ready, retry, ws])

  const sections: PaletteSection[] = []
  if (scope !== 'pages' || commandsOnly) {
    const goTo: SearchCommand[] = destinations.map(([name, label, icon, keywords]) => ({
      id: name, label, keywords, icon: <Icon name={icon} />, group: 'Workspace', run: () => go({ name }),
    }))
    const settings: SearchCommand[] = [
      { id: 'settings', label: 'Settings', group: 'Settings', keywords: 'preferences options تنظیمات', icon: <Icon name="settings" />, run: () => go({ name: 'settings' }) },
      ...SETTINGS_TABS.map(tab => ({
        id: 'settings-' + tab.id, label: t('Settings') + ' › ' + t(tab.title), icon: tab.icon, group: 'Settings',
        keywords: [tab.id, tab.label, tab.title, tab.hint, t(tab.hint)].join(' '),
        run: () => go({ name: 'settings', tab: tab.id }),
      })),
    ]
    for (const cmd of [...goTo, ...settings, ...commands]) {
      const label = t(cmd.label)
      const group = t(cmd.group)
      if (words.length ? !matches(words, [label, cmd.label, cmd.keywords, group, cmd.group].join(' ')) : cmd.searchOnly) continue
      let section = sections.find(item => item.label === group)
      if (!section) sections.push(section = { label: group, items: [] })
      section.items.push({
        id: 'cmd-' + cmd.id,
        icon: cmd.icon ?? <Icon name="arrow-right" size={16} className="ds-flip" />,
        title: <b dir="auto">{label}</b>,
        trailing: cmd.hint ? <kbd dir="ltr">{cmd.hint}</kbd> : <Icon name="arrow-right" size={14} className="ds-flip" />,
        onChoose: cmd.run,
      })
    }
  }

  const current = result?.term === term ? result : undefined
  if (!commandsOnly) {
    const visiblePages = ws.data.pages.filter(page => !page.trashed && page.id !== ws.data.settings.inbox)
    const byId = new Map(visiblePages.map(page => [page.id, page]))
    const results = !term
      ? [...visiblePages].sort((a, b) => (ws.search.touchedAt(b.id) || b.createdAt) - (ws.search.touchedAt(a.id) || a.createdAt)).slice(0, 6)
      : current && !current.failed
        ? current.ids.flatMap(id => byId.get(id) ?? [])
        : visiblePages.filter(page => matches(words, page.title)).slice(0, 20)
    if (results.length) sections.push({
      label: t(term ? 'Pages' : 'Recent'), count: results.length,
      items: results.map(page => ({
        id: 'page-' + page.id,
        icon: <Icon name={page.type === 'database' ? 'table' : ws.isFolder(page.id) ? 'folder' : 'file-text'} />,
        title: <b dir="auto">{page.title || t('Untitled')}</b>,
        detail: <small dir="auto">{ws.search.excerptOf(page.id).slice(0, 100)}</small>,
        onChoose: () => onOpen(page.id),
      })),
    })
  }

  return (
    <SearchPalette
      label={t('Search')} query={query} onQuery={setQuery} placeholder={t('Search pages or type a command.')}
      scopes={[{ id: 'all', label: t('All') }, { id: 'pages', label: t('Pages') }, { id: 'commands', label: t('Commands') }]}
      scope={commandsOnly ? 'commands' : scope} onScope={id => {
        setScope(id)
        if (id !== 'commands' && prefixed) setQuery(term)
      }}
      state={!commandsOnly && term && ready ? current?.failed ? 'failed' : current ? 'fresh' : 'pending' : 'fresh'}
      onRetry={() => { setResult(undefined); setRetry(value => value + 1) }}
      countLabel={t(term ? 'Search' : 'Recent')} sections={sections} emptyHint={t('No results')} onClose={onClose}
    />
  )
}
