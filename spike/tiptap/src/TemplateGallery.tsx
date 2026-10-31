import { useEffect } from 'react'
import { getTemplates } from './templates'
import { Glyph } from './iconSet'
import { Icon } from './design-system'
import { t } from './i18n'

/** Glyph shown for each built-in template (new pages get it as their icon). */
export const TEMPLATE_GLYPH: Record<string, string> = { lecture: 'graduation', chapter: 'book', exercise: 'target', meeting: 'users', todo: 'list' }

/** Ids of the two gallery entries that are not page templates: a whole-page drawing board and a database. */
export const BOARD_TEMPLATE = '__board'
export const DATABASE_TEMPLATE = '__database'

/** Template gallery as a page: pick one and a new page is created from it. */
export function Templates({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const list = getTemplates()
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const Card = ({ title, hint, icon, onClick, blank }: { title: string; hint: string; icon: React.ReactNode; onClick: () => void; blank?: boolean }) => (
    <button type="button" className={'tplv-card' + (blank ? ' blank' : '')} onClick={onClick}>
      <span className="tplv-pv" aria-hidden="true"><i className="h" /><i /><i /><i className="a" /><i /></span>
      <span className="tplv-bd">
        <span className="ds-tile ds-tile--md">{icon}</span>
        <span><b dir="auto">{title}</b><small dir="auto">{hint}</small></span>
      </span>
    </button>
  )

  return (
    <div className="tplv">
      <header className="tplv-head">
        <h1>{t('Templates')}</h1>
        <p>{t('Start a new page from a ready-made structure.')}</p>
      </header>
      <div className="tplv-grid">
        <Card blank title={t('Blank page')} hint={t('Start from scratch')} icon={<Icon name="plus" />} onClick={() => onPick('')} />
        <Card title={t('Database')} hint={t('Tables, views, forms and dashboards in one database.')} icon={<Icon name="database" />} onClick={() => onPick(DATABASE_TEMPLATE)} />
        <Card title={t('Drawing')} hint={t('A blank whiteboard for sketches and diagrams.')} icon={<Icon name="pencil" />} onClick={() => onPick(BOARD_TEMPLATE)} />
        {list.map((tp) => (
          <Card key={tp.id} title={tp.title} hint={tp.desc} icon={<Glyph name={TEMPLATE_GLYPH[tp.id] ?? 'page'} size={17} />} onClick={() => onPick(tp.id)} />
        ))}
      </div>
    </div>
  )
}
