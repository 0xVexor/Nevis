import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '../ui'
import { t } from '../i18n'
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

function Items({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  return (
    <>
      {items.map((it, n) => {
        if (it.kind === 'sep') return <div key={n} className="ds-menu-sep" role="separator" />
        if (it.kind === 'head') return <div key={n} className="ds-menu-head">{t(it.label)}</div>
        const label = it.raw ? it.label : t(it.label)
        return (
          <button
            key={n}
            type="button"
            role="menuitem"
            className="ds-menu-item"
            data-danger={it.danger || undefined}
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
          </button>
        )
      })}
    </>
  )
}

export function Menu({ anchor, items, onClose, align = 'start' }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; align?: 'start' | 'end' }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align}>
      <div className="ds-menu" role="menu">
        <Items items={items} onPick={onClose} />
      </div>
    </Popover>
  )
}

/** Replaces <select>: a button that shows the current choice and opens a menu of options. */
export function Dropdown<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string }) {
  const { open, menu } = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ds-dd-btn"
        aria-haspopup="menu"
        aria-label={t(label)}
        onClick={() => ref.current && open(options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) })), ref.current)}
      >
        <span>{current ? t(current.label) : ''}</span>
        <svg className="ds-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu}
    </>
  )
}
