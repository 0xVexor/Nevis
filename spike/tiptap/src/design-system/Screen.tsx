import type { ReactNode } from 'react'
import { cx } from './dir'

/**
 * A full-page tool screen (Tasks, Flashcards, Templates, Pages table, Trash): the page title, one line that says what
 * is here, the screen's own actions at the end, then the content. `width` picks the column: `narrow` for lists you read
 * down, `wide` for tables and two-pane screens. `fill` makes the screen exactly as tall as the window, so the content
 * shares that height instead of scrolling the page (panes inside it scroll on their own). Title and description are
 * already translated.
 */
export function Screen({
  title,
  description,
  actions,
  width = 'narrow',
  fill,
  className,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  width?: 'narrow' | 'wide'
  fill?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('ds-screen', className)} data-width={width} data-fill={fill || undefined}>
      <header className="ds-screen-head">
        <div className="ds-screen-title">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="ds-screen-acts">{actions}</div>}
      </header>
      {children}
    </div>
  )
}
