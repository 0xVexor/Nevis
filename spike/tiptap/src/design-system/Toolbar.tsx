import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from './dir'

/**
 * A floating or inline tool strip: one row of icon (or short text) buttons, split into groups by thin separators.
 * Group names are spoken (aria-label) and shown as tooltips on each button, not printed above the buttons.
 * DOM-built toolbars (image bar, zoom viewer) use the same classes: ds-toolbar, ds-toolbar-btn, ds-toolbar-sep.
 */
export function Toolbar({ label, className, children, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { label: string; ref?: Ref<HTMLDivElement> }) {
  return (
    <div {...rest} ref={ref} role="toolbar" aria-label={label} className={cx('ds-toolbar', className)}>
      {children}
    </div>
  )
}

export function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ds-toolbar-group" role="group" aria-label={label}>
      {children}
    </div>
  )
}

export const ToolbarSep = () => <span className="ds-toolbar-sep" role="separator" aria-orientation="vertical" />

type ToolbarButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  /** Required: names the button for screen readers and shows as its tooltip. */
  label: string
  pressed?: boolean
  danger?: boolean
  /** Short text (50%, RTL) instead of an icon. */
  text?: boolean
}

/** Keeps the editor selection: a mouse press on a tool must not move the caret. */
export function ToolbarButton({ label, pressed, danger, text, className, children, type = 'button', onMouseDown, ...rest }: ToolbarButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx('ds-icon-btn', 'ds-toolbar-btn', text && 'ds-toolbar-btn--text', danger && 'ds-toolbar-btn--danger', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onMouseDown={(e) => {
        e.preventDefault()
        onMouseDown?.(e)
      }}
    >
      {children}
    </button>
  )
}
