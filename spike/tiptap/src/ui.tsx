import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { normalizeFa } from './normalize'
import type { Page } from './repo'
import * as Ic from './icons'
import { GLYPHS, GLYPH_NAMES, Glyph, ICON_PREFIX, iconNode, isGlyph } from './iconSet'
import { t, locale } from './i18n'

/** Fixed-position popover anchored to a rect; closes on outside click / Escape. */
export function Popover({ anchor, onClose, children, align = 'start' }: { anchor: DOMRect; onClose: () => void; children: ReactNode; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = align === 'end' ? anchor.right - w : anchor.left
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    let top = anchor.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 4)
    setPos({ top, left })
  }, [anchor, align])

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div ref={ref} className="popover" style={{ top: pos.top, left: pos.left }}>
      {children}
    </div>
  )
}

type SelectOption = { value: string; label: string; color?: string }

/** Dropdown selector (replaces the native <select>): a field button that opens the shared menu, with a dot per option and a check on the current one. */
export function Select({ value, options, onChange, className, title, style }: { value: string; options: SelectOption[]; onChange: (v: string) => void; className?: string; title?: string; style?: React.CSSProperties }) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const cur = options.find((o) => o.value === value) ?? options[0]
  return (
    <>
      <button
        type="button"
        className={'sel ' + (className ?? '') + (rect ? ' open' : '')}
        style={style}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={!!rect}
        onMouseDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={(e) => (e.stopPropagation(), setRect(rect ? null : e.currentTarget.getBoundingClientRect()))}
      >
        {cur?.color && <i className="sel-dot" style={{ background: cur.color }} />}
        <span className="sel-label">{cur?.label}</span>
        <span className="sel-chev"><Ic.Chevron size={12} /></span>
      </button>
      {rect && (
        <Popover anchor={rect} onClose={() => setRect(null)}>
          <div className="menu sel-menu" role="listbox" style={{ minWidth: rect.width }} onClick={(e) => e.stopPropagation()}>
            {options.map((o) => (
              <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={'menu-item' + (o.value === value ? ' on' : '')} onClick={() => (onChange(o.value), setRect(null))}>
                <span className="menu-ic">{o.color ? <i className="sel-dot" style={{ background: o.color }} /> : null}</span>
                <span className="sel-label">{o.label}</span>
                {o.value === value && <span className="sel-check"><Ic.Check size={14} /></span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

export const MenuItem = ({ icon, label, onClick, danger, hint }: { icon?: ReactNode; label: string; onClick: () => void; danger?: boolean; hint?: string }) => (
  <button className={'menu-item' + (danger ? ' danger' : '')} onClick={onClick}>
    <span className="menu-ic">{icon}</span>
    {label}
    {hint && <span className="menu-hint">{hint}</span>}
  </button>
)

// Emoji are generated from Unicode ranges (the full set, no hand-kept list); curated search keywords below.
const RANGES: Record<string, [number, number][]> = {
  smileys: [[0x1f600, 0x1f64f], [0x1f910, 0x1f92f], [0x1f970, 0x1f97a], [0x1f9d0, 0x1f9d0]],
  people: [[0x1f440, 0x1f450], [0x1f466, 0x1f487], [0x1f90c, 0x1f90f], [0x1f918, 0x1f91f], [0x1f930, 0x1f93a], [0x1f9b0, 0x1f9bf], [0x1f9d1, 0x1f9df], [0x1f645, 0x1f64f], [0x1f64b, 0x1f64f]],
  nature: [[0x1f300, 0x1f320], [0x1f330, 0x1f344], [0x1f400, 0x1f43e], [0x1f980, 0x1f9ae], [0x1f9a0, 0x1f9a2], [0x1f990, 0x1f9a9], [0x2600, 0x2604], [0x26c4, 0x26c5], [0x2744, 0x2744]],
  food: [[0x1f345, 0x1f37f], [0x1f950, 0x1f96f], [0x1f9c0, 0x1f9cb], [0x2615, 0x2615]],
  activity: [[0x1f380, 0x1f3ce], [0x1f3cf, 0x1f3d3], [0x1f94a, 0x1f94f], [0x26bd, 0x26be], [0x1f3ae, 0x1f3af], [0x1f9e9, 0x1f9ff]],
  travel: [[0x1f680, 0x1f6c5], [0x1f3e0, 0x1f3f0], [0x1f5fa, 0x1f5ff], [0x1f6d0, 0x1f6d2], [0x1f6e0, 0x1f6ec], [0x26ea, 0x26fa], [0x2693, 0x2693]],
  objects: [[0x1f4a1, 0x1f4fc], [0x1f50a, 0x1f52e], [0x1f9e0, 0x1f9e8], [0x1fa70, 0x1faff], [0x231a, 0x231b], [0x23f0, 0x23f3], [0x1f4bc, 0x1f4dd], [0x1f5a5, 0x1f5a5], [0x1f6aa, 0x1f6bf]],
  symbols: [[0x1f493, 0x1f49f], [0x1f4af, 0x1f4af], [0x1f500, 0x1f53d], [0x1f7e0, 0x1f7eb], [0x2705, 0x2705], [0x274c, 0x274c], [0x2753, 0x2757], [0x2b50, 0x2b55], [0x2728, 0x2728], [0x26a1, 0x26a1], [0x1f3c1, 0x1f3c1], [0x1f6a9, 0x1f6a9]],
}
const buildEmoji = (): { id: string; icon: string; list: string[] }[] => {
  const seen = new Set<string>()
  const re = /\p{Emoji_Presentation}/u
  const tabs: [string, string][] = [['smileys', '😀'], ['people', '👋'], ['nature', '🌿'], ['food', '🍔'], ['activity', '⚽'], ['travel', '🚀'], ['objects', '💡'], ['symbols', '❤️']]
  return tabs.map(([id, icon]) => {
    const list: string[] = []
    for (const [a, b] of RANGES[id]) {
      for (let c = a; c <= b; c++) {
        const e = String.fromCodePoint(c)
        if (re.test(e) && !seen.has(e)) (seen.add(e), list.push(e))
      }
    }
    return { id, icon, list }
  })
}
let emojiCache: ReturnType<typeof buildEmoji> | null = null
const emojiTabs = () => (emojiCache ??= buildEmoji())

// search keywords for common emoji (the full set can still be browsed by category)
const KEYWORDS: Record<string, string> = {
  '😀': 'smile happy', '😄': 'grin happy', '😊': 'blush smile', '😂': 'laugh joy', '😍': 'love heart eyes', '🤔': 'think', '😎': 'cool', '😴': 'sleep', '😢': 'sad cry', '😡': 'angry', '🥳': 'party', '🤩': 'star struck', '🙌': 'hands praise', '👍': 'thumbs up like', '👋': 'wave hello', '🙏': 'pray thanks', '💪': 'strong muscle', '👀': 'eyes look',
  '📄': 'page document', '📝': 'note memo write', '📓': 'notebook', '📚': 'books', '🎓': 'graduation study', '💡': 'idea bulb', '📌': 'pin', '🗂️': 'folder files', '📅': 'calendar date', '💻': 'laptop computer', '☕': 'coffee', '🎯': 'target goal', '📐': 'ruler math', '🧮': 'abacus calc', '🔬': 'science microscope', '🎨': 'art palette', '🎵': 'music', '📷': 'camera photo', '🚀': 'rocket launch', '⚙️': 'settings gear', '🔒': 'lock secure', '📊': 'chart stats', '🧩': 'puzzle',
  '⭐': 'star', '🔥': 'fire hot', '✅': 'check done', '❤️': 'heart love', '💯': 'hundred', '✨': 'sparkles', '⚡': 'bolt lightning', '❗': 'important', '❓': 'question', '🏁': 'flag finish',
  '🌱': 'plant seedling', '🌍': 'earth world', '🌳': 'tree', '🌸': 'flower', '🌙': 'moon night', '☀️': 'sun', '🌈': 'rainbow', '🐱': 'cat', '🐶': 'dog', '🦋': 'butterfly',
}
const RECENT_KEY = 'emoji-recent'
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** Page icon picker: search, Recent, every emoji by category, and an Icons tab of outline glyphs (stored as `i:name`). */
export function EmojiPicker({ onPick, onClear }: { onPick: (e: string) => void; onClear: () => void }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('recent')
  const recent = readRecent()
  const tabs = emojiTabs()
  const query = q.trim().toLowerCase()
  const glyphMatches = (name: string) => !query || name.includes(query) || GLYPHS[name][0].includes(query)
  const emojiShown: string[] = query
    ? tabs.flatMap((x) => x.list).filter((e) => (KEYWORDS[e] ?? '').includes(query) || e === query)
    : tab === 'recent'
      ? recent.filter((e) => !isGlyph(e))
      : (tabs.find((x) => x.id === tab)?.list ?? [])
  const showGlyphs = query ? true : tab === 'icons'
  const glyphs = showGlyphs ? GLYPH_NAMES.filter(glyphMatches) : []
  const recentGlyphs = !query && tab === 'recent' ? recent.filter(isGlyph) : []
  const pick = (e: string) => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recent.filter((x) => x !== e)].slice(0, 12)))
    } catch {}
    onPick(e)
  }
  const empty = !emojiShown.length && !glyphs.length && !recentGlyphs.length
  return (
    <div className="emoji-pop">
      <input className="emoji-search" autoFocus placeholder={t('Search emojis...')} value={q} onChange={(e) => setQ(e.target.value)} />
      {!query && (
        <div className="emoji-tabs">
          <button className={tab === 'recent' ? 'on' : ''} title={t('Recent')} onClick={() => setTab('recent')}>🕘</button>
          {tabs.map((x) => (
            <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>{x.icon}</button>
          ))}
          <button className={'tab-icons' + (tab === 'icons' ? ' on' : '')} title={t('Icons')} onClick={() => setTab('icons')}><Glyph name="star" size={16} /></button>
        </div>
      )}
      <div className="emoji-head">
        <span>{query ? t('Results') : tab === 'recent' ? t('Recent') : tab === 'icons' ? t('Icons') : ''}</span>
        <button className="link" onClick={onClear}>{t('Delete')}</button>
      </div>
      <div className="emoji-grid">
        {recentGlyphs.map((e) => (
          <button key={e} onClick={() => pick(e)}>{iconNode(e, 20)}</button>
        ))}
        {emojiShown.map((e) => (
          <button key={e} onClick={() => pick(e)}>{e}</button>
        ))}
        {glyphs.map((n) => (
          <button key={n} className="glyph" title={n} onClick={() => pick(ICON_PREFIX + n)}><Glyph name={n} size={20} /></button>
        ))}
        {empty && <span className="emoji-empty">{query ? t('No emoji found') : t('Pick an emoji and it shows up here')}</span>}
      </div>
    </div>
  )
}

const textOf = (n: any): string => (n?.text ? n.text : (n?.content ?? []).map(textOf).join(' '))

export interface PaletteCommand { id: string; label: string; icon: ReactNode; keywords?: string; hint?: string; run: () => void }

/** Ctrl+K command palette: app commands and page search (titles + content) in one list. A leading "> " shows commands only. */
export function SearchModal({ pages, search, commands, onOpen, onClose }: { pages: Page[]; search: (q: string) => Page[]; commands: PaletteCommand[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const cmdOnly = q.startsWith('>')
  const term = cmdOnly ? q.slice(1) : q
  const words = useMemo(() => normalizeFa(term).split(/\s+/).filter(Boolean), [term])
  const cmds = useMemo(
    () => (words.length ? commands.filter((c) => { const h = normalizeFa(c.label + ' ' + (c.keywords ?? '')); return words.every((w) => h.includes(w)) }) : commands),
    [commands, words],
  )
  const found = useMemo(
    () => (cmdOnly ? [] : term.trim() ? search(term) : [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)),
    [cmdOnly, term, pages, search],
  )
  const shownCmds = term.trim() ? cmds.slice(0, 6) : cmds
  const items = useMemo(() => [...shownCmds.map((c) => ({ cmd: c })), ...found.map((p) => ({ page: p }))] as { cmd?: PaletteCommand; page?: Page }[], [shownCmds, found])

  useEffect(() => { setSel(0) }, [q])
  useEffect(() => { document.querySelector('.result.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const snippet = (p: Page) => {
    if (!words.length) return ''
    const raw = typeof p.content === 'string' ? '' : textOf(p.content)
    const i = normalizeFa(raw).indexOf(words[0])
    return i < 0 ? '' : (i > 20 ? '…' : '') + raw.slice(Math.max(0, i - 20), i + 60)
  }
  const choose = (it: { cmd?: PaletteCommand; page?: Page }) => {
    onClose()
    if (it.cmd) it.cmd.run()
    else if (it.page) onOpen(it.page.id)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-search">
          <Ic.Search size={18} />
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
              else if (e.key === 'Enter' && items[sel]) (e.preventDefault(), choose(items[sel]))
            }}
          />
          <kbd className="palette-kbd">Ctrl K</kbd>
        </div>
        <div className="modal-list">
          {items.length === 0 && <div className="modal-empty">{t('No results found')}</div>}
          {shownCmds.length > 0 && <div className="modal-label">{t('Commands')}</div>}
          {shownCmds.map((c, i) => (
            <button key={c.id} className={'result' + (i === sel ? ' sel' : '')} onMouseMove={() => setSel(i)} onClick={() => choose({ cmd: c })}>
              <span className="result-ic">{c.icon}</span>
              <span className="result-tx"><b dir="auto">{c.label}</b></span>
              {c.hint && <kbd className="result-kbd">{c.hint}</kbd>}
            </button>
          ))}
          {found.length > 0 && <div className="modal-label">{term.trim() ? t('Results') : t('Recent')}</div>}
          {found.map((p, j) => {
            const i = shownCmds.length + j
            return (
              <button key={p.id} className={'result' + (i === sel ? ' sel' : '')} onMouseMove={() => setSel(i)} onClick={() => choose({ page: p })}>
                <span className="result-ic">{iconNode(p.icon, 16, <Ic.Page />)}</span>
                <span className="result-tx">
                  <b dir="auto">{p.title || t('Untitled')}</b>
                  {snippet(p) && <small dir="auto">{snippet(p)}</small>}
                </span>
                <span className="result-meta">{ago(p.updatedAt)}</span>
              </button>
            )
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t('Navigate')}</span><span><kbd>↵</kbd> {t('Select')}</span><span><kbd>Esc</kbd> {t('Close')}</span><span className="palette-tip">{t('Type > for commands only')}</span></div>
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
          {items.length > 0 && <button className="danger-link" onClick={onEmpty}>{t('Empty trash')}</button>}
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
