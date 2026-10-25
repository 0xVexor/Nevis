import { getTemplates } from './templates'
import { Glyph } from './iconSet'
import * as Ic from './icons'
import { t } from './i18n'

/** Glyph shown for each built-in template (new pages get it as their icon). */
export const TEMPLATE_GLYPH: Record<string, string> = { lecture: 'graduation', chapter: 'book', exercise: 'target', meeting: 'users', todo: 'list' }

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
