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
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal tpl-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head">
          <div>
            <b>{t('Templates')}</b>
            <small>{t('Start a new page from a ready-made structure.')}</small>
          </div>
          <button className="icon-btn" title={t('Close')} onClick={onClose}><Ic.Close /></button>
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
            <small>{t('A table you can also see as a board, calendar, list or chart.')}</small>
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
    </div>
  )
}
