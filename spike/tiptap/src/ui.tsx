// App glue around the design system: the search palette's data, the app toast event and relative times.
import type { DocNode } from './docNode'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { normalizeFa } from './normalize'
import type { Page } from './repo'
import { iconNode } from './iconSet'
import { Icon, SearchPalette, type PaletteItem, type PaletteSection } from './design-system'
import { t, locale } from './i18n'
import { shortcutHint } from './shortcuts'

const textOf = (n: DocNode | null | undefined): string => (n?.text ? n.text : (n?.content ?? []).map(textOf).join(' '))

export interface PaletteCommand {
  id: string
  label: string
  icon: ReactNode
  keywords?: string
  group?: string
  searchOnly?: boolean
  hint?: string
  run: () => void
}

type PaletteScope = 'all' | 'pages' | 'cmds'

/** Ctrl+K palette: app commands and page search (titles + content) in one list. A leading "> " (or the Commands tab) shows commands only. */
export function SearchModal({
  pages,
  search,
  commands,
  onOpen,
  onClose,
  initialQuery = '',
  onSaveSearch,
}: {
  pages: Page[]
  search: (q: string) => Promise<Page[]>
  commands: PaletteCommand[]
  onOpen: (id: string) => void
  onClose: () => void
  initialQuery?: string
  onSaveSearch?: (query: string) => void
}) {
  const [q, setQ] = useState(initialQuery)
  const [scope, setScope] = useState<PaletteScope>('all')
  const cmdOnly = q.startsWith('>') || scope === 'cmds'
  const pagesOnly = scope === 'pages'
  const term = q.startsWith('>') ? q.slice(1) : q
  const words = useMemo(() => normalizeFa(term).split(/\s+/).filter(Boolean), [term])
  const cmds = useMemo(
    () =>
      words.length
        ? commands.filter((c) => {
            const h = normalizeFa(c.label + ' ' + (c.keywords ?? '') + ' ' + (c.group ? t(c.group) : ''))
            return words.every((w) => h.includes(w))
          })
        : commands.filter((command) => !command.searchOnly),
    [commands, words],
  )
  const recent = useMemo(() => [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [pages])
  const [found, setFound] = useState<Page[]>(recent)
  const [searchState, setSearchState] = useState<'fresh' | 'pending' | 'failed'>('fresh')
  const [searchEpoch, setSearchEpoch] = useState(0)
  useEffect(() => {
    const refreshed = (event: Event) => {
      const state = (event as CustomEvent<string>).detail
      if (state === 'fresh') setSearchEpoch((value) => value + 1)
      else if (term.trim() && !cmdOnly && (state === 'pending' || state === 'failed')) {
        setFound([])
        setSearchState(state)
      }
    }
    window.addEventListener('search-state', refreshed)
    return () => window.removeEventListener('search-state', refreshed)
  }, [term, cmdOnly])
  useEffect(() => {
    if (cmdOnly) {
      setSearchState('fresh')
      return setFound([])
    }
    if (!term.trim()) {
      setSearchState('fresh')
      return setFound(recent)
    }
    setFound([])
    setSearchState('pending')
    let alive = true // an older, slower answer must not replace a newer one
    const id = window.setTimeout(
      () =>
        void search(term)
          .then((r) => {
            if (alive) {
              setFound(r)
              setSearchState('fresh')
            }
          })
          .catch((error) => {
            if (alive) {
              setFound([])
              setSearchState(error?.state === 'pending' ? 'pending' : 'failed')
            }
          }),
      60,
    )
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [cmdOnly, term, recent, search, searchEpoch])

  const snippet = (p: Page & { searchPassage?: string }) => {
    if (p.searchPassage !== undefined) return p.searchPassage
    const raw = typeof p.content === 'string' ? '' : textOf(p.content)
    if (!words.length) return raw.trim().slice(0, 70)
    const i = normalizeFa(raw).indexOf(words[0])
    return i < 0 ? raw.trim().slice(0, 70) : (i > 20 ? '…' : '') + raw.slice(Math.max(0, i - 20), i + 60)
  }
  const hl = (text: string): ReactNode => {
    const ws = term
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!ws.length) return text
    return text.split(new RegExp('(' + ws.join('|') + ')', 'ig')).map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s))
  }

  // the commands in their groups, in the order the groups first appear, then the pages
  const sections: PaletteSection[] = []
  if (!pagesOnly)
    for (const command of cmds) {
      const label = t(command.group ?? 'Commands')
      let section = sections.find((s) => s.label === label)
      if (!section) sections.push((section = { label, items: [] }))
      section.items.push({
        id: command.id,
        icon: command.icon,
        title: <b dir="auto">{hl(command.label)}</b>,
        trailing: command.hint ? <kbd dir="ltr">{shortcutHint(command.hint)}</kbd> : <Icon name="arrow-right" size={14} />,
        onChoose: command.run,
      } satisfies PaletteItem)
    }
  sections.push({
    label: t(term.trim() ? 'Pages' : 'Recent'),
    count: found.length,
    items: found.map((page) => {
      const passage = snippet(page)
      return {
        id: page.id,
        icon: iconNode(page.icon, 18, <Icon name="file" size={18} />),
        title: <b dir="auto">{hl(page.title || t('Untitled'))}</b>,
        detail: passage ? <small dir="auto">{hl(passage)}</small> : undefined,
        trailing: <time>{ago(page.updatedAt)}</time>,
        onChoose: () => onOpen(page.id),
      }
    }),
  })
  const canSave = !!onSaveSearch && !!term.trim() && !cmdOnly

  return (
    <SearchPalette
      label={t('Search')}
      query={q}
      onQuery={setQ}
      placeholder={t('Search pages or type a command.')}
      scopes={[
        { id: 'all', label: t('All') },
        { id: 'pages', label: t('Pages') },
        { id: 'cmds', label: t('Commands') },
      ]}
      scope={cmdOnly ? 'cmds' : scope}
      onScope={(id) => {
        setScope(id as PaletteScope)
        if (id !== 'cmds' && q.startsWith('>')) setQ(q.slice(1).trimStart())
      }}
      countLabel={t(term.trim() ? 'Search' : 'Recent')}
      sections={sections}
      state={!cmdOnly && term.trim() ? searchState : 'fresh'}
      onRetry={() => setSearchEpoch((value) => value + 1)}
      emptyHint={t('Try a different word, or search the content of your pages.')}
      tip={t('Type > for commands only')}
      saveLabel={canSave ? t('Save this search') : undefined}
      onSave={canSave ? () => onSaveSearch!(term.trim()) : undefined}
      onClose={onClose}
    />
  )
}

/** Event a screen sends to show the app's toast; with `undo`, the toast offers Undo and Ctrl+Z runs it. */
export const APP_TOAST = 'app-toast'
/** With `undo` the toast offers Undo (and Ctrl+Z runs it); `action` is any other one-click follow-up ("Show it"), without the shortcut. */
export const showToast = (msg: string, undo?: () => void, action?: { label: string; run: () => void }) => window.dispatchEvent(new CustomEvent(APP_TOAST, { detail: { msg, undo, action } }))

const rtf = () => new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
export function ago(ts: number) {
  const s = Math.round((ts - Date.now()) / 1000)
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [Infinity, 'day'],
  ]
  const div = [1, 60, 3600, 86400]
  for (let i = 0; i < steps.length; i++) if (Math.abs(s) < steps[i][0]) return rtf().format(Math.round(s / div[i]), steps[i][1])
  return ''
}
