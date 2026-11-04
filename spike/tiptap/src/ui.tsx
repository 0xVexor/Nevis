import { CommandDialog, CommandResult } from './design-system/CommandDialog'
import { Dialog, FormField, Icon } from './design-system'
import { Button, IconButton } from './design-system/Button'
import type { DocNode } from './docNode'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { normalizeFa } from './normalize'
import type { Page } from './repo'
import { ICON_PREFIX, iconNode, parseIcon } from './iconSet'
import { IconPicker } from './design-system/IconPicker'
import { t, locale } from './i18n'
import { shortcutHint } from './shortcuts'

export const MenuItem = ({
  icon,
  label,
  onClick,
  danger,
  hint,
  desc,
  disabled,
}: {
  icon?: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  hint?: string
  desc?: string
  disabled?: boolean
}) => (
  <button className="ds-menu-item" data-danger={danger || undefined} onClick={onClick} disabled={disabled}>
    <span className="ds-menu-ic">{icon}</span>
    {desc ? (
      <span className="ds-menu-label">
        <b>{label}</b>
        <small>{desc}</small>
      </span>
    ) : (
      <span className="ds-menu-label">{label}</span>
    )}
    {hint && (
      <span className="ds-menu-hint" dir="ltr">
        {shortcutHint(hint)}
      </span>
    )}
  </button>
)

/** Small caption that groups the items below it. */
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="ds-menu-head">{children}</div>
export const MenuSep = () => <div className="ds-menu-sep" />


/** Page icon picker: search, a colour row and a grid of simple outline glyphs (stored as `i:name` or `i:name@#colour`). Pages that already have an emoji keep showing it. */
/** Page and inline icons: the design system's picker, stored as `i:name` or `i:name@#rrggbb`. */
export function EmojiPicker({ onPick, onClear, current, clearLabel }: { onPick: (e: string, close?: boolean) => void; onClear: () => void; current?: string; clearLabel?: string }) {
  const cur = current && current.startsWith(ICON_PREFIX) ? parseIcon(current) : null
  return <IconPicker name={cur?.name} color={cur?.color} clearLabel={clearLabel} onClear={onClear} onPick={(name, color, close) => onPick(ICON_PREFIX + name + (color ? '@' + color : ''), close)} />
}

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
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState(initialQuery)
  const [sel, setSel] = useState(0)
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
        : commands.filter(command => !command.searchOnly),
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
  const shownCmds = useMemo(() => {
    if (pagesOnly) return []
    const groups = new Map<string | undefined, PaletteCommand[]>()
    for (const command of cmds) {
      const group = groups.get(command.group) ?? []
      group.push(command)
      groups.set(command.group, group)
    }
    return [...groups.values()].flat()
  }, [pagesOnly, cmds])
  const items = useMemo(() => [...shownCmds.map((c) => ({ cmd: c })), ...found.map((p) => ({ page: p }))] as { cmd?: PaletteCommand; page?: Page }[], [shownCmds, found])

  useEffect(() => {
    setSel(0)
  }, [q, scope])
  useEffect(() => {
    document.querySelector('.palette .result.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

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
  const choose = (it: { cmd?: PaletteCommand; page?: Page }) => {
    onClose()
    if (it.cmd) it.cmd.run()
    else if (it.page) onOpen(it.page.id)
  }
  const scopes: [PaletteScope, string][] = [
    ['all', t('All')],
    ['pages', t('Pages')],
    ['cmds', t('Commands')],
  ]

  return <CommandDialog label={t('Search')} onClose={onClose}
    header={<>
      <span className="ds-command-search-icon"><Icon name="search" size={20} /></span>
      <div className="ds-command-input-wrap"><label htmlFor="workspace-search-query">{t('Search')}</label>
        <input id="workspace-search-query" ref={input} dir="auto" autoComplete="off" spellCheck={false} placeholder={t('Search pages or type a command.')} value={q}
          onChange={event => setQ(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setSel(value => Math.max(0, Math.min(value + 1, items.length - 1))) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setSel(value => Math.max(value - 1, 0)) }
            else if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); setScope(value => scopes[(scopes.findIndex(([key]) => key === value) + 1) % scopes.length][0]) }
            else if (event.key === 'Enter' && items[sel]) { event.preventDefault(); choose(items[sel]) }
          }} />
      </div>
      {onSaveSearch && term.trim() && !cmdOnly && <IconButton label={t('Save this search')} onClick={() => { onClose(); onSaveSearch(term.trim()) }}><Icon name="star" size={18} /></IconButton>}
      {q && <IconButton label={t('Clear')} onClick={() => { setQ(''); input.current?.focus() }}><Icon name="x" size={16} /></IconButton>}
      <IconButton label={t('Close')} className="ds-command-close" onClick={onClose}><Icon name="x" size={18} /></IconButton>
    </>}
    filters={<>
      <div className="ds-command-scopes" role="group" aria-label={t('Search')}>
        {scopes.map(([key, label]) => <button type="button" key={key} aria-pressed={(cmdOnly ? 'cmds' : scope) === key} onClick={() => { setScope(key); if (key !== 'cmds' && q.startsWith('>')) setQ(q.slice(1).trimStart()); input.current?.focus() }}>{label}</button>)}
      </div>
      <span className="ds-command-count" aria-live="polite" aria-atomic="true"><span className="ds-badge">{items.length}</span><span>{t(term.trim() ? 'Search' : 'Recent')}</span></span>
    </>}
    footer={<>
      <span><kbd>&#8593;</kbd><kbd>&#8595;</kbd>{t('Navigate')}</span>
      <span><kbd>Enter</kbd>{t('Select')}</span>
      <span><kbd>Tab</kbd>{t('Switch tab')}</span>
      <span><kbd>Esc</kbd>{t('Close')}</span>
      <span className="ds-command-tip">{t('Type > for commands only')}</span>
    </>}>
    {!cmdOnly && term.trim() && searchState !== 'fresh' && <div className="ds-command-empty" role="status">
      <span className="ds-command-state-icon" data-pending={searchState === 'pending' || undefined}><Icon name="search" size={24} /></span>
      <b>{t(searchState === 'failed' ? 'Search is unavailable. Try again.' : 'Searching.')}</b>
      {searchState === 'failed' && <Button size="sm" onClick={() => setSearchEpoch(value => value + 1)}>{t('Try again')}</Button>}
    </div>}
    {items.length === 0 && searchState === 'fresh' && <div className="ds-command-empty" role="status">
      <span className="ds-command-state-icon"><Icon name="search" size={24} /></span>
      <b>{t('No results found')}</b><p>{t('Try a different word, or search the content of your pages.')}</p>
      <Button size="sm" variant="ghost" onClick={() => { setQ(''); setScope('all'); input.current?.focus() }}>{t('Clear')}</Button>
    </div>}
    {shownCmds.map((command, index) => <Fragment key={command.id}>
      {(index === 0 || command.group !== shownCmds[index - 1]?.group) && <div className="ds-command-group-label">{t(command.group ?? 'Commands')}</div>}
      <CommandResult selected={index === sel} icon={command.icon} onMouseMove={() => setSel(index)} onClick={() => choose({ cmd: command })}
      trailing={command.hint ? <kbd dir="ltr">{shortcutHint(command.hint)}</kbd> : <Icon name="arrow-right" size={14} />}><b dir="auto">{hl(command.label)}</b></CommandResult>
    </Fragment>)}
    {found.length > 0 && <div className="ds-command-group-label">{t(term.trim() ? 'Pages' : 'Recent')}<span>{found.length}</span></div>}
    {found.map((page, index) => {
      const selectedIndex = shownCmds.length + index, passage = snippet(page)
      return <CommandResult key={page.id} selected={selectedIndex === sel} icon={iconNode(page.icon, 18, <Icon name="file" size={18} />)} onMouseMove={() => setSel(selectedIndex)} onClick={() => choose({ page })} trailing={<time>{ago(page.updatedAt)}</time>}>
        <b dir="auto">{hl(page.title || t('Untitled'))}</b>{passage && <small dir="auto">{hl(passage)}</small>}
      </CommandResult>
    })}
  </CommandDialog>
}

/** Event a screen sends to show the app's toast; with `undo`, the toast offers Undo and Ctrl+Z runs it. */
export const APP_TOAST = 'app-toast'
/** With `undo` the toast offers Undo (and Ctrl+Z runs it); `action` is any other one-click follow-up ("Show it"), without the shortcut. */
export const showToast = (msg: string, undo?: () => void, action?: { label: string; run: () => void }) => window.dispatchEvent(new CustomEvent(APP_TOAST, { detail: { msg, undo, action } }))

export function Toast({ msg, action, onAction, onClose }: { msg: string; action?: string; onAction?: () => void; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 7000)
    return () => window.clearTimeout(t)
  }, [msg, onClose])
  return (
    <div className="ds-toast ds-toast--app" role="status">
      <Icon name="check" size={16} />
      <span dir="auto">{msg}</span>
      {action && (
        <Button size="sm" variant="ghost" onClick={() => (onAction?.(), onClose())} title={action + '  Ctrl+Z'}>
          {action}
        </Button>
      )}
    </div>
  )
}

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

/** Small dialog that asks for one name (new folder, rename). Enter confirms, Esc or a click outside cancels. */
export function NameDialog({
  title,
  label,
  initial,
  action,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial: string
  action: string
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const submit = () => (onSubmit(value.trim()), onClose())
  // the design-system Dialog focuses the first control, which is the name field
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" type="submit" form="name-dialog">
            {action}
          </Button>
        </>
      }
    >
      <form id="name-dialog" className="ds-modal-body" onSubmit={(e) => (e.preventDefault(), submit())}>
        <FormField label={label}>
          <input ref={ref} className="ds-field" aria-label={label} dir="auto" value={value} onChange={(e) => setValue(e.target.value)} />
        </FormField>
      </form>
    </Dialog>
  )
}
