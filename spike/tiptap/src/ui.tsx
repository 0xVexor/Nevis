import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { normalizeFa } from './normalize'
import { createPortal } from 'react-dom'
import type { Page } from './repo'
import * as Ic from './icons'
import { GLYPHS, GLYPH_NAMES, Glyph, ICON_PREFIX, iconNode, parseIcon } from './iconSet'
import { t, locale } from './i18n'
import { shortcutHint } from './shortcuts'

/** Fixed-position popover anchored to a rect; closes on outside click / Escape. Arrow keys / Home / End move through its items. */
export function Popover({ anchor, onClose, children, align = 'start' }: { anchor: DOMRect; onClose: () => void; children: ReactNode; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH?: number }>({ top: anchor.bottom + 6, left: anchor.left })

  // Placed under the anchor (above it when there is no room) and kept in view while its content grows or shrinks:
  // a tall popover scrolls inside itself instead of running off the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = el.scrollHeight + 2
      const below = window.innerHeight - anchor.bottom - 14
      const above = anchor.top - 14
      let left = align === 'end' ? anchor.right - w : anchor.left
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      let top: number
      let maxH: number | undefined
      if (h <= below) top = anchor.bottom + 6
      else if (h <= above) top = anchor.top - h - 6
      else if (Math.max(below, above) < 200) (top = 8, maxH = window.innerHeight - 16)
      else if (below >= above) (top = anchor.bottom + 6, maxH = below)
      else (top = anchor.top - 6 - above, maxH = above)
      setPos((p) => (p.top === top && p.left === left && p.maxH === maxH ? p : { top, left, maxH }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => (ro.disconnect(), window.removeEventListener('resize', place))
  }, [anchor, align])

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button.menu-item:not(:disabled)') ?? [])]
      if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1
      items[n].focus()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos.top, left: pos.left, ...(pos.maxH ? { maxHeight: pos.maxH, overflowY: 'auto' } : null) }}>
      {children}
    </div>, document.body,
  )
}

type SelectOption = { value: string; label: string; color?: string }

/** Dropdown selector (replaces the native <select>): a field button that opens the shared menu, with a dot per option and a check on the current one. */
export function Select({ value, options, onChange, className, title, style, disabled, id, ...aria }: { value: string; options: SelectOption[]; onChange: (v: string) => void; className?: string; title?: string; style?: React.CSSProperties; disabled?: boolean; id?: string; 'aria-label'?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; dir?: 'auto' | 'ltr' | 'rtl' }) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [inline, setInline] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const cur = options.find((o) => o.value === value) ?? options[0]
  const open = !!rect || inline
  const close = () => (setRect(null), setInline(false))
  const list = (
    <div className="menu sel-menu" role="listbox" style={inline ? undefined : { minWidth: Math.max(rect?.width ?? 0, 180) }} onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={'menu-item' + (o.value === value ? ' on' : '')} onClick={() => (onChange(o.value), close())}>
          <span className="menu-ic">{o.color ? <i className="sel-dot" style={{ background: o.color }} /> : null}</span>
          <span className="menu-tx">{o.label}</span>
          {o.value === value && <span className="sel-check"><Ic.Check size={14} /></span>}
        </button>
      ))}
    </div>
  )
  return (
    <>
      <button
        ref={btn}
        {...aria}
        id={id}
        disabled={disabled}
        type="button"
        className={'selbox ' + (className ?? '') + (open ? ' open' : '')}
        style={style}
        title={title}
        aria-label={aria['aria-label'] ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (open) return close()
          // inside a popover or a dialog the list opens in place, under the field, not as a second popup over it
          if (btn.current?.closest('.popover, .modal, .db-modal-body')) setInline(true)
          else setRect(e.currentTarget.getBoundingClientRect())
        }}
      >
        {cur?.color && <i className="sel-dot" style={{ background: cur.color }} />}
        <span className="sel-label">{cur?.label}</span>
        <span className="sel-chev"><Ic.Chevron size={12} /></span>
      </button>
      {inline && <div className="sel-inline">{list}</div>}
      {rect && <Popover anchor={rect} onClose={close}>{list}</Popover>}
    </>
  )
}

export const MenuItem = ({ icon, label, onClick, danger, hint, desc, disabled }: { icon?: ReactNode; label: string; onClick: () => void; danger?: boolean; hint?: string; desc?: string; disabled?: boolean }) => (
  <button className={'menu-item' + (danger ? ' danger' : '')} onClick={onClick} disabled={disabled}>
    <span className="menu-ic">{icon}</span>
    {desc ? <span className="menu-tx"><b>{label}</b><small>{desc}</small></span> : <span className="menu-tx">{label}</span>}
    {hint && <span className="menu-hint" dir="ltr">{shortcutHint(hint)}</span>}
  </button>
)

/** Small caption that groups the items below it. */
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>
export const MenuSep = () => <div className="menu-sep" />

const ICON_COLORS = ['#6a5cff', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b']

/** Page icon picker: search, a colour row and a grid of simple outline glyphs (stored as `i:name` or `i:name@#colour`). Pages that already have an emoji keep showing it. */
export function EmojiPicker({ onPick, onClear, current, clearLabel }: { onPick: (e: string, close?: boolean) => void; onClear: () => void; current?: string; clearLabel?: string }) {
  const [q, setQ] = useState('')
  const cur = current && current.startsWith(ICON_PREFIX) ? parseIcon(current) : null
  const [color, setColor] = useState<string | undefined>(cur?.color)
  const query = q.trim().toLowerCase()
  const names = GLYPH_NAMES.filter((n) => !query || n.includes(query) || GLYPHS[n][0].includes(query))
  const make = (n: string, c = color) => ICON_PREFIX + n + (c ? '@' + c : '')
  return (
    <div className="emoji-pop">
      <input className="emoji-search" autoFocus placeholder={t('Search icons…')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="icon-colors" role="radiogroup" aria-label={t('Icon colour')}>
        <button type="button" role="radio" aria-checked={!color} className={'icon-color auto' + (!color ? ' on' : '')} title={t('Automatic')} onClick={() => (setColor(undefined), cur && onPick(make(cur.name, undefined), false))} />
        {ICON_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} className={'icon-color' + (color === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => (setColor(c), cur && onPick(make(cur.name, c), false))} />
        ))}
      </div>
      <div className="emoji-head">
        <span>{t('Icons')} · {names.length}</span>
        <button className="link" onClick={onClear}>{clearLabel ?? t('Remove icon')}</button>
      </div>
      <div className="emoji-grid">
        {names.map((n) => (
          <button key={n} className={'glyph' + (cur?.name === n ? ' on' : '')} title={n} onClick={() => onPick(make(n))}><Glyph name={n} size={20} color={color} /></button>
        ))}
        {names.length === 0 && <span className="emoji-empty">{t('No icon found')}</span>}
      </div>
    </div>
  )
}

const textOf = (n: any): string => (n?.text ? n.text : (n?.content ?? []).map(textOf).join(' '))

export interface PaletteCommand { id: string; label: string; icon: ReactNode; keywords?: string; hint?: string; run: () => void }

type PaletteScope = 'all' | 'pages' | 'cmds'

/** Ctrl+K palette: app commands and page search (titles + content) in one list. A leading "> " (or the Commands tab) shows commands only. */
export function SearchModal({ pages, search, commands, onOpen, onClose, initialQuery = '', onSaveSearch }: { pages: Page[]; search: (q: string) => Promise<Page[]>; commands: PaletteCommand[]; onOpen: (id: string) => void; onClose: () => void; initialQuery?: string; onSaveSearch?: (query: string) => void }) {
  const [q, setQ] = useState(initialQuery)
  const [sel, setSel] = useState(0)
  const [scope, setScope] = useState<PaletteScope>('all')
  const cmdOnly = q.startsWith('>') || scope === 'cmds'
  const pagesOnly = scope === 'pages'
  const term = q.startsWith('>') ? q.slice(1) : q
  const words = useMemo(() => normalizeFa(term).split(/\s+/).filter(Boolean), [term])
  const cmds = useMemo(
    () => (words.length ? commands.filter((c) => { const h = normalizeFa(c.label + ' ' + (c.keywords ?? '')); return words.every((w) => h.includes(w)) }) : commands),
    [commands, words],
  )
  const recent = useMemo(() => [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [pages])
  const [found, setFound] = useState<Page[]>(recent)
  useEffect(() => {
    if (cmdOnly) return setFound([])
    if (!term.trim()) return setFound(recent)
    let alive = true // an older, slower answer must not replace a newer one
    const id = window.setTimeout(() => void search(term).then((r) => alive && setFound(r)), 60)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [cmdOnly, term, recent, search])
  const shownCmds = pagesOnly ? [] : term.trim() && !cmdOnly ? cmds.slice(0, 5) : cmds
  const items = useMemo(() => [...shownCmds.map((c) => ({ cmd: c })), ...found.map((p) => ({ page: p }))] as { cmd?: PaletteCommand; page?: Page }[], [shownCmds, found])

  useEffect(() => { setSel(0) }, [q, scope])
  useEffect(() => { document.querySelector('.palette .result.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const snippet = (p: Page) => {
    const raw = typeof p.content === 'string' ? '' : textOf(p.content)
    if (!words.length) return raw.trim().slice(0, 70)
    const i = normalizeFa(raw).indexOf(words[0])
    return i < 0 ? raw.trim().slice(0, 70) : (i > 20 ? '…' : '') + raw.slice(Math.max(0, i - 20), i + 60)
  }
  const hl = (text: string): ReactNode => {
    const ws = term.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!ws.length) return text
    return text.split(new RegExp('(' + ws.join('|') + ')', 'ig')).map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s))
  }
  const choose = (it: { cmd?: PaletteCommand; page?: Page }) => {
    onClose()
    if (it.cmd) it.cmd.run()
    else if (it.page) onOpen(it.page.id)
  }
  const scopes: [PaletteScope, string][] = [['all', t('All')], ['pages', t('Pages')], ['cmds', t('Commands')]]

  return (
    <div className="overlay palette-overlay" onMouseDown={onClose}>
      <div className="modal palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-search">
          <span className="pal-sic"><Ic.Search size={18} /></span>
          <input
            autoFocus
            dir="auto"
            placeholder={t('Search pages or type a command…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, items.length - 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)))
              else if (e.key === 'Tab') (e.preventDefault(), setScope((s) => scopes[(scopes.findIndex(([k]) => k === s) + 1) % scopes.length][0]))
              else if (e.key === 'Enter' && items[sel]) (e.preventDefault(), choose(items[sel]))
            }}
          />
          {onSaveSearch && term.trim() && !cmdOnly && <button className="icon-btn" title={t('Save this search')} onClick={() => (onClose(), onSaveSearch(term.trim()))}><Ic.Star /></button>}
          {q && <button className="icon-btn" title={t('Clear')} onClick={() => setQ('')}><Ic.Close size={15} /></button>}
        </div>
        <div className="pal-tabs">
          {scopes.map(([k, label]) => (
            <button key={k} className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>{label}</button>
          ))}
          <span className="pal-count">{items.length}</span>
        </div>
        <div className="pal-list">
          {items.length === 0 && (
            <div className="pal-empty">
              <span className="fc2-art"><Ic.Search size={26} /></span>
              <b>{t('No results found')}</b>
              <small>{t('Try a different word, or search the content of your pages.')}</small>
            </div>
          )}
          {shownCmds.length > 0 && <div className="modal-label">{t('Commands')}</div>}
          {shownCmds.map((c, i) => (
            <button key={c.id} className={'result' + (i === sel ? ' sel' : '')} onMouseMove={() => setSel(i)} onClick={() => choose({ cmd: c })}>
              <span className="result-ic">{c.icon}</span>
              <span className="result-tx"><b dir="auto">{hl(c.label)}</b></span>
              {c.hint ? <kbd className="result-kbd" dir="ltr">{shortcutHint(c.hint)}</kbd> : <span className="result-go"><Ic.Arrow size={14} /></span>}
            </button>
          ))}
          {found.length > 0 && <div className="modal-label">{term.trim() ? t('Pages') : t('Recent')}</div>}
          {found.map((p, j) => {
            const i = shownCmds.length + j
            const sn = snippet(p)
            return (
              <button key={p.id} className={'result' + (i === sel ? ' sel' : '')} onMouseMove={() => setSel(i)} onClick={() => choose({ page: p })}>
                <span className="result-ic">{iconNode(p.icon, 17, <Ic.Page size={17} />)}</span>
                <span className="result-tx">
                  <b dir="auto">{hl(p.title || t('Untitled'))}</b>
                  {sn && <small dir="auto">{hl(sn)}</small>}
                </span>
                <span className="result-meta">{ago(p.updatedAt)}</span>
              </button>
            )
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t('Navigate')}</span><span><kbd>↵</kbd> {t('Select')}</span><span><kbd>Tab</kbd> {t('Switch tab')}</span><span><kbd>Esc</kbd> {t('Close')}</span><span className="palette-tip">{t('Type > for commands only')}</span></div>
      </div>
    </div>
  )
}

export function Toast({ msg, action, onAction, onClose }: { msg: string; action?: string; onAction?: () => void; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 7000)
    return () => window.clearTimeout(t)
  }, [msg, onClose])
  return (
    <div className="toast" role="status">
      <span className="toast-ic"><Ic.Check size={13} /></span>
      <span dir="auto">{msg}</span>
      {action && (
        <button onClick={() => (onAction?.(), onClose())}>{action}</button>
      )}
    </div>
  )
}

const rtf = () => new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
export function ago(ts: number) {
  const s = Math.round((ts - Date.now()) / 1000)
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [Infinity, 'day']]
  const div = [1, 60, 3600, 86400]
  for (let i = 0; i < steps.length; i++) if (Math.abs(s) < steps[i][0]) return rtf().format(Math.round(s / div[i]), steps[i][1])
  return ''
}

export function TrashModal({ items, days, onRestore, onPurge, onEmpty, onClose }: {
  items: Page[]
  days: number
  onRestore: (id: string) => void
  onPurge: (p: Page) => void
  onEmpty: () => void
  onClose: () => void
}) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()} tabIndex={-1}>
        <div className="modal-head">
          <div>
            <b>{t('Trash')}</b>
            <small>{t('Pages are deleted permanently after {days} days.', { days })}</small>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {items.length > 0 && <button className="danger-link" onClick={onEmpty}>{t('Empty trash')}</button>}
            <button className="icon-btn" title={t('Close')} onClick={onClose}><Ic.Close size={16} /></button>
          </span>
        </div>
        <div className="modal-list">
          {items.length === 0 && <div className="modal-empty">{t('The trash is empty')}</div>}
          {items.map((p) => (
            <div key={p.id} className="result trash-row">
              <span className="result-ic">{iconNode(p.icon, 16, <Ic.Page />)}</span>
              <span className="result-tx">
                <b dir="auto">{p.title || t('Untitled')}</b>
                <small>{ago(p.deletedAt!)}</small>
              </span>
              <span className="trash-acts">
                <button onClick={() => onRestore(p.id)}>{t('Restore')}</button>
                <button className="danger" onClick={() => onPurge(p)}>{t('Delete permanently')}</button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Small dialog that asks for one name (new folder, rename). Enter confirms, Esc or a click outside cancels. */
export function NameDialog({ title, label, initial, action, onSubmit, onClose }: { title: string; label: string; initial: string; action: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const submit = () => (onSubmit(value.trim()), onClose())
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="modal name-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => (e.preventDefault(), submit())} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><b>{title}</b></div>
        <label className="nd-body">
          <span>{label}</span>
          <input ref={ref} dir="auto" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        <div className="nd-acts">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="primary">{action}</button>
        </div>
      </form>
    </div>
  )
}
