import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconButton } from './Button'
import { CommandDialog, CommandResult } from './CommandDialog'
import { Icon } from './icons'
import { t } from './text'

/** One result: a command or an item. The app builds the title (with its own highlighting), the detail and the trailing part. */
export interface PaletteItem {
  id: string
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  onChoose: () => void
}
export interface PaletteSection {
  label: string
  /** shown after the label when given */
  count?: number
  items: PaletteItem[]
}

/**
 * The search and command palette (Ctrl K) without any search of its own: the app passes the query, the scopes and the
 * result sections, and gets the changes back. Arrow keys move through every section, Enter chooses, Tab moves to the next
 * scope, Escape closes. `state` says whether the results are current, still coming, or could not be found. Labels are
 * translated; `title` and `detail` are the app's own text.
 */
export function SearchPalette({
  label,
  query,
  onQuery,
  placeholder,
  scopes,
  scope,
  onScope,
  countLabel,
  sections,
  state = 'fresh',
  onRetry,
  emptyHint,
  tip,
  saveLabel,
  onSave,
  onClose,
}: {
  label: string
  query: string
  onQuery: (q: string) => void
  placeholder: string
  scopes: { id: string; label: string }[]
  scope: string
  onScope: (id: string) => void
  countLabel: string
  sections: PaletteSection[]
  state?: 'fresh' | 'pending' | 'failed'
  onRetry?: () => void
  emptyHint?: string
  tip?: string
  saveLabel?: string
  onSave?: () => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [sel, setSel] = useState(0)
  const items = sections.flatMap((s) => s.items)
  useEffect(() => setSel(0), [query, scope])
  useEffect(() => {
    document.querySelector('.ds-command-dialog .ds-command-result[data-selected]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  const choose = (it: PaletteItem | undefined) => {
    if (!it) return
    onClose()
    it.onChoose()
  }
  const nextScope = () => onScope(scopes[(scopes.findIndex((s) => s.id === scope) + 1) % scopes.length].id)
  let index = -1
  return (
    <CommandDialog
      label={label}
      onClose={onClose}
      header={
        <>
          <span className="ds-command-search-icon">
            <Icon name="search" size={20} />
          </span>
          <div className="ds-command-input-wrap">
            <label htmlFor="ds-palette-query">{label}</label>
            <input
              id="ds-palette-query"
              ref={input}
              dir="auto"
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'ArrowDown') (e.preventDefault(), setSel((v) => Math.max(0, Math.min(v + 1, items.length - 1))))
                else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((v) => Math.max(v - 1, 0)))
                else if (e.key === 'Tab' && !e.shiftKey) (e.preventDefault(), nextScope())
                else if (e.key === 'Enter' && items[sel]) (e.preventDefault(), choose(items[sel]))
              }}
            />
          </div>
          {onSave && saveLabel && (
            <IconButton label={saveLabel} onClick={() => (onClose(), onSave())}>
              <Icon name="star" size={18} />
            </IconButton>
          )}
          {query && (
            <IconButton label={t('Clear')} onClick={() => (onQuery(''), input.current?.focus())}>
              <Icon name="x" size={16} />
            </IconButton>
          )}
          <IconButton label={t('Close')} className="ds-command-close" onClick={onClose}>
            <Icon name="x" size={18} />
          </IconButton>
        </>
      }
      filters={
        <>
          <div className="ds-command-scopes" role="group" aria-label={label}>
            {scopes.map((s) => (
              <button type="button" key={s.id} aria-pressed={scope === s.id} onClick={() => (onScope(s.id), input.current?.focus())}>
                {s.label}
              </button>
            ))}
          </div>
          <span className="ds-command-count" aria-live="polite" aria-atomic="true">
            <span className="ds-badge">{items.length}</span>
            <span>{countLabel}</span>
          </span>
        </>
      }
      footer={
        <>
          <span>
            <kbd>&#8593;</kbd>
            <kbd>&#8595;</kbd>
            {t('Navigate')}
          </span>
          <span>
            <kbd>Enter</kbd>
            {t('Select')}
          </span>
          <span>
            <kbd>Tab</kbd>
            {t('Switch tab')}
          </span>
          <span>
            <kbd>Esc</kbd>
            {t('Close')}
          </span>
          {tip && <span className="ds-command-tip">{tip}</span>}
        </>
      }
    >
      {state !== 'fresh' && (
        <div className="ds-command-empty" role="status">
          <span className="ds-command-state-icon" data-pending={state === 'pending' || undefined}>
            <Icon name="search" size={24} />
          </span>
          <b>{t(state === 'failed' ? 'Search is unavailable. Try again.' : 'Searching.')}</b>
          {state === 'failed' && onRetry && (
            <Button size="sm" onClick={onRetry}>
              {t('Try again')}
            </Button>
          )}
        </div>
      )}
      {items.length === 0 && state === 'fresh' && (
        <div className="ds-command-empty" role="status">
          <span className="ds-command-state-icon">
            <Icon name="search" size={24} />
          </span>
          <b>{t('No results found')}</b>
          {emptyHint && <p>{emptyHint}</p>}
          <Button size="sm" variant="ghost" onClick={() => (onQuery(''), onScope(scopes[0].id), input.current?.focus())}>
            {t('Clear')}
          </Button>
        </div>
      )}
      {sections.map((section, si) =>
        section.items.length ? (
          <Fragment key={si + section.label}>
            <div className="ds-command-group-label">
              {section.label}
              {section.count !== undefined && <span>{section.count}</span>}
            </div>
            {section.items.map((it) => {
              const i = ++index
              return (
                <CommandResult key={it.id} selected={i === sel} icon={it.icon} onMouseMove={() => setSel(i)} onClick={() => choose(it)} trailing={it.trailing}>
                  {it.title}
                  {it.detail}
                </CommandResult>
              )
            })}
          </Fragment>
        ) : null,
      )}
    </CommandDialog>
  )
}
