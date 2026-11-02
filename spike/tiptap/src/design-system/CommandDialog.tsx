import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './commands.css'

/** Search/command surface with application-owned results, query and filtering. */
export function CommandDialog({ label, header, filters, footer, children, onClose, dir }: {
  label: string
  header: ReactNode
  filters?: ReactNode
  footer?: ReactNode
  children: ReactNode
  onClose: () => void
  dir?: 'ltr' | 'rtl'
}) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = box.current
    element?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(<div className="ds-command-scrim" onMouseDown={onClose}>
    <div ref={box} dir={dir} className="ds-command-dialog" role="dialog" aria-modal="true" aria-label={label} onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled), [tabindex="0"]')].filter(control => control.getClientRects().length > 0)
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <header className="ds-command-header">{header}</header>
      {filters && <div className="ds-command-filters">{filters}</div>}
      <div className="ds-command-results">{children}</div>
      {footer && <footer className="ds-command-footer">{footer}</footer>}
    </div>
  </div>, document.body)
}

export function CommandResult({ icon, trailing, selected = false, children, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  icon: ReactNode
  trailing?: ReactNode
  selected?: boolean
}) {
  return <button {...props} type="button" className="ds-command-result" data-selected={selected || undefined}>
    <span className="ds-command-result-icon">{icon}</span>
    <span className="ds-command-result-text">{children}</span>
    {trailing && <span className="ds-command-result-trailing">{trailing}</span>}
  </button>
}
