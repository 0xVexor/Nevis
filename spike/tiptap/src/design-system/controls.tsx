import { Fragment, type CSSProperties, type ElementType, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from './dir'

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
  return <span className={cx('ds-chip', dot && 'ds-chip--dot', className)} style={color ? ({ '--c': color } as CSSProperties) : undefined}>{children}</span>
}

export interface TabItem { id: string; label: string; icon?: ReactNode }

/** A row of tabs. Labels are already translated by the caller. */
export function Tabs({ items, value, onChange, className }: { items: TabItem[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('ds-tabs', className)}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>{item.icon}{item.label}</button>
      ))}
    </div>
  )
}

/** A titled group on a page: heading, an optional action at the end, then the content. */
export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('ds-section', className)}>
      <header><h2>{title}</h2>{action}</header>
      {children}
    </section>
  )
}

/** Labels and values for a summary. Labels and string values are already translated by the caller. */
export function Facts({ items, className }: { items: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('ds-facts', className)}>
      {items.map(([label, value]) => (
        <Fragment key={label}><dt>{label}</dt><dd dir="auto">{value}</dd></Fragment>
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
