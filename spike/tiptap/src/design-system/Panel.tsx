import { useId, type ReactNode } from 'react'
import { cx } from './dir'
import { IconButton } from './Button'
import { Icon } from './icons'
import { Switch } from './controls'
import { t } from './text'

/**
 * The body of a popover that holds a small form or a list of rules (filter, sort, property settings, a cell editor):
 * an optional title line with a back button and actions, the content, and the actions at the end. `size` sets the width:
 * `sm` 280, `md` 360, `lg` 520. Put it inside `Popover`; the popover itself draws the frame and the shadow.
 */
export function Panel({
  title,
  onBack,
  actions,
  footer,
  size = 'md',
  className,
  children,
}: {
  title?: ReactNode
  onBack?: () => void
  actions?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('ds-panel', className)} data-size={size} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {(title || onBack || actions) && (
        <header className="ds-panel-head">
          {onBack && (
            <IconButton label={t('Back')} onClick={onBack}>
              <Icon name="chevron-left" size={16} className="ds-flip" />
            </IconButton>
          )}
          {title && <h3 className="ds-panel-title">{title}</h3>}
          {actions && <div className="ds-panel-acts">{actions}</div>}
        </header>
      )}
      <div className="ds-panel-body">{children}</div>
      {footer && <footer className="ds-panel-foot">{footer}</footer>}
    </div>
  )
}

/** A labelled control in a form: the label above, the control, an optional hint below. Label and hint are translated. */
export function FormField({ label, hint, className, children }: { label: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className={cx('ds-form-field', className)} role="group" aria-labelledby={id}>
      <span id={id} className="ds-form-label">
        {label}
      </span>
      {children}
      {hint && <small className="ds-form-hint">{hint}</small>}
    </div>
  )
}

/** Choose one of 2–4 short options (`ds-seg`): a radio group whose labels are already translated. */
export function Segmented<V extends string>({ value, options, onChange, label, disabled }: { value: V; options: { value: V; label: string; title?: string }[]; onChange: (v: V) => void; label: string; disabled?: boolean }) {
  return (
    <div className="ds-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A switch with its label beside it, the whole line clickable; for settings inside panels and dialogs. */
export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <div className="ds-switch-row" data-disabled={disabled || undefined} onClick={() => !disabled && onChange(!checked)}>
      <span className="ds-switch-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      </span>
    </div>
  )
}
