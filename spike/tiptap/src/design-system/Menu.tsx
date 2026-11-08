import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Popover } from './Popover'
import { t } from './text'
import { useMenu } from './useMenu'

/**
 * Menu, dropdown and context menu: one component for every floating list.
 * Visual reference: docs/design-system/index.html → Menus. Styles: components.css (.ds-menu*).
 * Labels are English keys and pass through t(); set `raw` for user text such as page titles.
 */
export type MenuItem =
  | { kind: 'sep' }
  | { kind: 'head'; label: string }
  | {
      kind?: 'item'
      label: string
      icon?: ReactNode
      /** colour dot used by status menus, instead of an icon */
      swatch?: string
      hint?: string
      checked?: boolean
      danger?: boolean
      disabled?: boolean
      raw?: boolean
      onSelect?: () => void
      /** submenu; opens on hover or focus */
      items?: MenuItem[]
    }

const Chevron = () => (
  <svg className="ds-icon ds-menu-sub-icon" viewBox="0 0 24 24" style={{ width: 14, height: 14, marginInlineStart: 'auto' }} aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
)
const Check = () => (
  <svg className="ds-icon ds-menu-check" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
)

/**
 * A submenu is placed against the window, beside its item: a long menu scrolls inside its popover,
 * and a submenu positioned inside that scrolling box would be cut off.
 */
function placeSubmenu(item: HTMLElement) {
  const sub = item.querySelector<HTMLElement>(':scope > .ds-submenu')
  if (!sub) return
  // measured now (hover and focus already show it); a submenu not yet laid out falls back to its minimum width
  const r = item.getBoundingClientRect(),
    w = sub.offsetWidth || 190,
    h = sub.offsetHeight || 200
  const rtl = getComputedStyle(item).direction === 'rtl'
  let left = rtl ? r.left - w - 4 : r.right + 4
  // no room on the reading side: open on the other side
  if (left + w > innerWidth - 8 || left < 8) left = rtl ? r.right + 4 : r.left - w - 4
  sub.style.position = 'fixed'
  sub.style.insetInlineStart = 'auto'
  sub.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`
  sub.style.top = `${Math.max(8, Math.min(r.top - 7, innerHeight - h - 8))}px`
}

function Items({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  return (
    <>
      {items.map((it, n) => {
        if (it.kind === 'sep') return <div key={n} className="ds-menu-sep" role="separator" />
        if (it.kind === 'head')
          return (
            <div key={n} className="ds-menu-head">
              {t(it.label)}
            </div>
          )
        const label = it.raw ? it.label : t(it.label)
        // an item with a submenu is not a button: its submenu holds buttons, and a button may not contain another
        const Tag = it.items ? 'div' : 'button'
        return (
          <Tag
            key={n}
            {...(it.items ? { tabIndex: 0, 'aria-haspopup': 'menu' as const } : { type: 'button' as const })}
            role="menuitem"
            className="ds-menu-item"
            data-danger={it.danger || undefined}
            disabled={it.items ? undefined : it.disabled}
            onMouseEnter={it.items ? (e) => placeSubmenu(e.currentTarget) : undefined}
            onFocus={it.items ? (e) => placeSubmenu(e.currentTarget) : undefined}
            onClick={() => {
              if (it.items) return
              onPick()
              it.onSelect?.()
            }}
          >
            {it.swatch ? <i className="ds-menu-dot" style={{ background: it.swatch }} /> : (it.icon ?? <span className="ds-menu-gap" />)}
            <span className="ds-menu-label">{label}</span>
            {it.checked && <Check />}
            {it.hint && <kbd className="ds-menu-hint">{it.hint}</kbd>}
            {it.items && <Chevron />}
            {it.items && (
              <div className="ds-pop ds-menu ds-submenu" role="menu">
                <Items items={it.items} onPick={onPick} />
              </div>
            )}
          </Tag>
        )
      })}
    </>
  )
}

export function Menu({
  anchor,
  items,
  onClose,
  align = 'start',
  autoFocus = false,
  header,
}: {
  anchor: DOMRect
  items: MenuItem[]
  /** custom content above the items, such as the table size grid; a focusable part marks itself with data-menu-item to join the arrow keys */
  header?: ReactNode
  onClose: () => void
  align?: 'start' | 'end'
  /** focus the first item when it opens, for a menu opened from the keyboard */
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.ds-menu-item')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])
  return (
    <Popover anchor={anchor} onClose={onClose} align={align}>
      <div ref={ref} className="ds-menu" role="menu">
        {header}
        <Items items={items} onPick={onClose} />
      </div>
    </Popover>
  )
}

/**
 * Replaces <select>: a button that shows the current choice and opens a menu of options. Option labels pass through t()
 * unless `raw` (user text such as a property name). `placeholder` shows, dimmed, when no option has the value.
 */
export function Dropdown<V extends string>({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  className,
}: {
  value: V
  options: { value: V; label: string; raw?: boolean; swatch?: string }[]
  onChange: (v: V) => void
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const { open, menu } = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  const text = current ? (current.raw ? current.label : t(current.label)) : (placeholder ?? '')
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={'ds-dd-btn' + (className ? ' ' + className : '')}
        aria-haspopup="menu"
        aria-label={t(label)}
        title={text}
        disabled={disabled}
        data-empty={current ? undefined : ''}
        onClick={() =>
          ref.current &&
          open(
            options.map((o) => ({ label: o.label, raw: o.raw, swatch: o.swatch, checked: o.value === value, onSelect: () => onChange(o.value) })),
            ref.current,
          )
        }
      >
        {current?.swatch && <i className="ds-menu-dot" style={{ background: current.swatch }} />}
        <span dir="auto">{text}</span>
        <svg className="ds-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu}
    </>
  )
}
