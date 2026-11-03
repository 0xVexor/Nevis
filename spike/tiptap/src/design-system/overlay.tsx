import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useUIMotion } from './motion'

/**
 * A modal dialog: a title, a body and the actions at the end. Escape and a click on the scrim close it, focus moves in
 * on open and returns to where it was on close. For a quick yes/no or a one-line prompt use dialog.tsx (confirmDialog,
 * promptDialog); use this when the dialog has its own content.
 */
export function Dialog({ open, title, onClose, children, actions }: { open: boolean; title: string; onClose: () => void; children?: ReactNode; actions?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const uiMotion = useUIMotion()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return void (e.stopPropagation(), close.current())
      // Tab stays inside the dialog: from the last control back to the first, and the reverse
      if (e.key !== 'Tab' || !box.current) return
      const items = [...box.current.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
      )
      if (!items.length) return e.preventDefault()
      const edge = e.shiftKey ? items[0] : items[items.length - 1]
      const wrap = e.shiftKey ? items[items.length - 1] : items[0]
      if (document.activeElement === edge || !box.current.contains(document.activeElement)) (e.preventDefault(), wrap.focus())
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [open])
  return createPortal(
    <AnimatePresence>
      {open && <motion.div key="scrim" className="ds-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={uiMotion.transition} />}
      {open && (
        <div key="layer" className="ds-modal-layer">
          <motion.div
            ref={box}
            className="ds-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={uiMotion.transition}
          >
            <h2>{title}</h2>
            {children}
            {actions && <div className="ds-modal-actions">{actions}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
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
