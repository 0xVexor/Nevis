import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A modal dialog: a title, a body and the actions at the end. Escape and a click on the scrim close it, focus moves in
 * on open and returns to where it was on close. For a quick yes/no or a one-line prompt use dialog.tsx (confirmDialog,
 * promptDialog); use this when the dialog has its own content.
 */
export function Dialog({ open, title, onClose, children, actions }: { open: boolean; title: string; onClose: () => void; children?: ReactNode; actions?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), close.current())
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <>
      <div className="ds-scrim" onClick={onClose} />
      <div ref={box} className="ds-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {actions && <div className="ds-modal-actions">{actions}</div>}
      </div>
    </>,
    document.body,
  )
}

/** A short label on hover or keyboard focus. Wraps one control; the control keeps its own accessible name. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="ds-tip" data-tip={label}>
      {children}
    </span>
  )
}
