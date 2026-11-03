import { Fragment, useId, type ButtonHTMLAttributes, type CSSProperties, type ElementType, type HTMLAttributes, type InputHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cx } from './dir'
import { useUIMotion } from './motion'
import { Icon } from './icons'

/** A container: `interactive` for clickable cards, `selected` for the chosen one. */
export function Card({ as: Tag = 'div', interactive, selected, className, ...rest }: HTMLAttributes<HTMLElement> & { as?: ElementType; interactive?: boolean; selected?: boolean }) {
  return <Tag {...rest} className={cx('ds-card', interactive && 'ds-card--interactive', selected && 'ds-card--selected', className)} />
}

/** On / off. In lists and tables use a checkbox (`ds-check`) instead. */
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx('ds-switch', className)} onClick={() => onChange(!checked)} />
}

/** Text input. The direction follows what is typed unless `ltr` (codes, URLs, numbers). */
export function Field({ ltr, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'dir'> & { ltr?: boolean }) {
  return <input {...rest} className={cx('ds-field', className)} dir={ltr ? 'ltr' : 'auto'} />
}

/** Tag, status or label. Set `color` for the dot and tint, `dot` for a status dot. */
export function Chip({ children, color, dot, className }: { children: ReactNode; color?: string; dot?: boolean; className?: string }) {
  return (
    <span className={cx('ds-chip', dot && 'ds-chip--dot', className)} style={color ? ({ '--c': color } as CSSProperties) : undefined}>
      {children}
    </span>
  )
}

export interface TabItem {
  id: string
  label: string
  icon?: ReactNode
}

/** A row of tabs. Labels are already translated by the caller. */
export function Tabs({ items, value, onChange, className }: { items: TabItem[]; value: string; onChange: (id: string) => void; className?: string }) {
  const bar = useId()
  const motionOf = useUIMotion()
  return (
    <div role="tablist" className={cx('ds-tabs', className)}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>
          {item.icon}
          {item.label}
          {item.id === value && <motion.span layoutId={bar} className="ds-tab-bar" transition={motionOf.spring} />}
        </button>
      ))}
    </div>
  )
}

/** A titled group on a page: heading, an optional action at the end, then the content. */
export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('ds-section', className)}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

/** Labels and values for a summary. Labels and string values are already translated by the caller. */
export function Facts({ items, className }: { items: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('ds-facts', className)}>
      {items.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd dir="auto">{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** One thing that needs to be seen. `warn` and `bad` always come with words and an icon. */
export function Notice({ tone, icon, children, className }: { tone?: 'warn' | 'bad'; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div role={tone ? 'alert' : 'note'} className={cx('ds-notice', tone && `ds-notice--${tone}`, className)}>
      {icon}
      <div>{children}</div>
    </div>
  )
}

/** A chip that is a control: a status picker, an add action. `empty` draws it dashed (nothing set yet). */
export function ChipButton({ empty, icon, className, children, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { empty?: boolean; icon?: ReactNode }) {
  return (
    <button {...rest} type={type} className={cx('ds-chip-btn', className)} data-empty={empty || undefined}>
      {icon}
      {children}
    </button>
  )
}

/** The hue a tag is tinted with: the same name always gets the same colour. */
export const tagHue = (label: string) => [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

/** A tag in its own colour. With `onOpen` the name is a button; with `onRemove` a cross appears on hover or focus. Labels are already translated. */
export function Tag({
  label,
  onOpen,
  openLabel,
  onRemove,
  removeLabel,
  onContextMenu,
}: {
  label: string
  onOpen?: () => void
  openLabel?: string
  onRemove?: () => void
  removeLabel?: string
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}) {
  return (
    <span className="ds-tag" dir="auto" style={{ '--hue': tagHue(label) } as CSSProperties} onContextMenu={onContextMenu}>
      {onOpen ? (
        <button type="button" className="ds-tag-name" title={openLabel} onClick={onOpen}>
          {label}
        </button>
      ) : (
        <span className="ds-tag-name">{label}</span>
      )}
      {onRemove && (
        <button type="button" className="ds-tag-x" aria-label={`${removeLabel} ${label}`} title={removeLabel} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  )
}

/** The properties of an object, one row each. `label` names the group for assistive technology. */
export function PropertyList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section className={cx('ds-props', className)} aria-label={label}>
      {children}
    </section>
  )
}

/** One property: an optional icon and its label, then the value. */
export function PropertyRow({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="ds-prop">
      <span className="ds-prop-label">
        {icon}
        {label}
      </span>
      <div className="ds-prop-value">{children}</div>
    </div>
  )
}

/** A small grid of the actions an object offers, each a tile with its icon over a short label. */
export function ActionGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('ds-actions', className)}>{children}</div>
}

/** One action in an ActionGrid. The label is already translated. */
export function ActionTile({ icon, label, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: string }) {
  return (
    <button {...rest} type={type} className={cx('ds-action', className)}>
      {icon}
      <span>{label}</span>
    </button>
  )
}
