// A button that opens a Menu (split out of Menu.tsx: it uses `useMenu`, which uses `Menu`, and that made an import cycle).
import { useRef } from 'react'
import { t } from './text'
import { useMenu } from './useMenu'

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
  'data-testid': testid,
}: {
  value: V
  options: { value: V; label: string; raw?: boolean; swatch?: string }[]
  onChange: (v: V) => void
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
  'data-testid'?: string
}) {
  const { open, close, menu, isOpen } = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  const text = current ? (current.raw ? current.label : t(current.label)) : (placeholder ?? '')
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-testid={testid}
        data-value={value}
        className={'ds-dd-btn' + (className ? ' ' + className : '')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t(label)}
        title={text}
        disabled={disabled}
        data-empty={current ? undefined : ''}
        onClick={() =>
          isOpen ? close() : ref.current &&
          open(
            options.map((o) => ({ label: o.label, value: o.value, raw: o.raw, swatch: o.swatch, checked: o.value === value, onSelect: () => onChange(o.value) })),
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

