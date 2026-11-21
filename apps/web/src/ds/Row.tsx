import type { ElementType, HTMLAttributes, ReactNode } from 'react'
import { cx, dirOf } from './dir'

type RowProps = Omit<HTMLAttributes<HTMLElement>, 'dir'> & {
  as?: ElementType
  icon?: ReactNode
  /** The user text of the row. It decides the row's direction, so a Persian title puts the icon on the right. */
  text?: string
  /** Force a direction instead of reading it from `text`. */
  dir?: 'rtl' | 'ltr' | 'auto'
  trailing?: ReactNode
}

/**
 * An icon next to a piece of text: sidebar items, list rows, card headers.
 * The direction is set on the row itself (not only on the text), so the icon, the gap and the trailing
 * content all follow the text. Use this instead of a hand-made flex row whenever the text comes from the user.
 */
export function Row({ as: Tag = 'div', icon, text, dir, trailing, className, children, ...rest }: RowProps) {
  return (
    <Tag {...rest} className={cx('ds-row', className)} dir={dir ?? dirOf(text)}>
      {icon}
      <span className="ds-row-text">{children ?? text}</span>
      {trailing}
    </Tag>
  )
}
