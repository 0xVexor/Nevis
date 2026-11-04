import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from './dir'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  icon?: ReactNode
}

/** One primary action per view. Label with a verb: "Save changes", not "Submit". */
export function Button({ variant = 'default', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={cx('ds-btn', variant !== 'default' && `ds-btn--${variant}`, size === 'sm' && 'ds-btn--sm', className)}>
      {icon}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  ref?: Ref<HTMLButtonElement>
  /** Required: an icon-only button has no other name. Also shown as the tooltip. */
  label: string
  pressed?: boolean
}

export function IconButton({ label, pressed, className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} className={cx('ds-icon-btn', className)} aria-label={label} title={rest.title ?? label} aria-pressed={pressed}>
      {children}
    </button>
  )
}
