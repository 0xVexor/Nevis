import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconButton } from './ds'
import { t } from './i18n'
import { RowPage } from './RowPage'
import type { Workspace } from './workspace'

export function DatabaseRowPeek({ ws, dbId, rowId, onClose, onFullPage }: {
  ws: Workspace
  dbId: string
  rowId: string
  onClose: () => void
  onFullPage: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement
    const app = document.querySelector<HTMLElement>('.app')
    const background = app?.contains(closeButton.current) ? null : app
    const wasInert = background?.inert ?? false
    if (background) background.inert = true
    closeButton.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.dv-peek .pg-find')) return
      const layers = document.querySelectorAll('.ds-pop, .slash-menu, .ds-command-dialog, .ds-modal-layer, .lightbox[open], .lang-pop')
      if ([...layers].some(layer => layer.getClientRects().length && getComputedStyle(layer).visibility === 'visible')) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      if (background) background.inert = wasInert
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(
    <div className="dv-peek-layer" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="dv-peek" role="dialog" aria-modal="true" aria-label={t('Open as page')} data-testid="row-peek">
        <header className="dv-peek-bar">
          <IconButton ref={closeButton} label={t('Close')} data-testid="row-peek-close" onClick={onClose}><Icon name="x" size={17} /></IconButton>
          <IconButton label={t('Open as full page')} data-testid="row-peek-full" onClick={onFullPage}><Icon name="maximize" size={16} /></IconButton>
        </header>
        <div className="dv-peek-body"><RowPage ws={ws} dbId={dbId} id={rowId} peek /></div>
      </section>
    </div>,
    document.fullscreenElement ?? document.body,
  )
}
