import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { getTemplates } from './templates'
import { Glyph } from './iconSet'
import * as Ic from './icons'
import { t } from './i18n'

/** Glyph shown for each built-in template (new pages get it as their icon). */
export const TEMPLATE_GLYPH: Record<string, string> = { lecture: 'graduation', chapter: 'book', exercise: 'target', meeting: 'users', todo: 'list' }

/** Ids of the two gallery entries that are not page templates: a whole-page drawing board and a database. */
export const BOARD_TEMPLATE = '__board'
export const DATABASE_TEMPLATE = '__database'

/** Template gallery: pick one and a new page is created from it. */
export function Templates({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const list = getTemplates()
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeButton.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(
    <div className="overlay tpl-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="modal tpl-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
        if (e.key === 'Tab') {
          const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const first = buttons[0], last = buttons[buttons.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <div className="modal-head">
          <div>
            <b id={titleId}>{t('Templates')}</b>
            <small>{t('Start a new page from a ready-made structure.')}</small>
          </div>
          <button ref={closeButton} type="button" className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}><Ic.Close /></button>
        </div>
        <div className="tpl-grid">
          <button className="tpl-card blank" onClick={() => onPick('')}>
            <span className="tpl-ic"><Ic.Plus size={22} /></span>
            <b>{t('Blank page')}</b>
            <small>{t('Start from scratch')}</small>
          </button>
          <button className="tpl-card" style={{ ['--hue' as string]: 200 } as React.CSSProperties} onClick={() => onPick(DATABASE_TEMPLATE)}>
            <span className="tpl-ic"><Ic.Table size={24} /></span>
            <b>{t('Database')}</b>
            <small>{t('Tables, views, forms and dashboards in one database.')}</small>
            <span className="tpl-use">{t('Use template')}<Ic.Arrow size={14} /></span>
          </button>
          <button className="tpl-card" style={{ ['--hue' as string]: 20 } as React.CSSProperties} onClick={() => onPick(BOARD_TEMPLATE)}>
            <span className="tpl-ic"><Ic.Pencil size={24} /></span>
            <b>{t('Drawing')}</b>
            <small>{t('A blank whiteboard for sketches and diagrams.')}</small>
            <span className="tpl-use">{t('Use template')}<Ic.Arrow size={14} /></span>
          </button>
          {list.map((tp, i) => (
            <button key={tp.id} className="tpl-card" style={{ ['--hue' as string]: [40, 200, 150, 300, 20, 260][i % 6] } as React.CSSProperties} onClick={() => onPick(tp.id)}>
              <span className="tpl-ic"><Glyph name={TEMPLATE_GLYPH[tp.id] ?? 'page'} size={24} /></span>
              <b dir="auto">{tp.title}</b>
              <small dir="auto">{tp.desc}</small>
              <span className="tpl-use">{t('Use template')}<Ic.Arrow size={14} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>, document.body,
  )
}
