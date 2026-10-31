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

const SAMPLE: Record<string, string> = { lecture: 'doc', chapter: 'quote', exercise: 'exercise', meeting: 'meeting', todo: 'todo' }

/** Template gallery as a page: pick one and a new page is created from it. */
export function Templates({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const list = getTemplates()
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  /** A small black-and-white picture of what the template creates. */
  const Sample = ({ kind }: { kind: string }) => {
    const L = (w: number, strong?: boolean) => <i className={strong ? 'h' : ''} style={{ inlineSize: w + '%' }} />
    if (kind === 'todo') return <span className="tplv-s">{[70, 55, 80].map((w, i) => <span key={w} className="row"><u className={i === 1 ? 'on' : ''} />{L(w)}</span>)}</span>
    if (kind === 'table') return <svg className="tplv-svg" viewBox="0 0 160 90"><rect x="6" y="6" width="148" height="78" rx="6" /><path d="M6 24h148M6 44h148M6 64h148M56 6v78M104 6v78" /><path className="fill" d="M10 12h40v6H10zM60 12h38v6H60zM108 12h38v6h-38z" /></svg>
    if (kind === 'draw') return <svg className="tplv-svg" viewBox="0 0 160 90"><rect x="14" y="14" width="46" height="30" rx="6" /><circle cx="122" cy="58" r="20" /><path d="M60 29h30a12 12 0 0 1 12 12v0M78 70H50" /><path d="m98 37 4 4 4-4" /></svg>
    if (kind === 'meeting') return <span className="tplv-s">{L(50, true)}<span className="row dots"><b /><b /><b /></span>{L(86)}{L(64)}<span className="row"><u />{L(55)}</span></span>
    if (kind === 'exercise') return <span className="tplv-s">{L(46, true)}<span className="row"><em>1</em>{L(70)}</span><span className="row"><em>2</em>{L(58)}</span><span className="row"><em>3</em>{L(76)}</span></span>
    if (kind === 'quote') return <span className="tplv-s">{L(50, true)}{L(88)}<span className="row quote">{L(60)}</span>{L(72)}</span>
    return <span className="tplv-s">{L(50, true)}{L(90)}{L(78)}<span className="row"><b />{L(60)}</span><span className="row"><b />{L(46)}</span></span>
  }

  const Card = ({ title, hint, icon, onClick, blank, sample }: { title: string; hint: string; icon: React.ReactNode; onClick: () => void; blank?: boolean; sample?: string }) => (
    <button type="button" className={'tplv-card' + (blank ? ' blank' : '')} onClick={onClick}>
      <span className="tplv-pv" aria-hidden="true">{blank ? <Icon name="plus" size={26} /> : <Sample kind={sample ?? 'doc'} />}</span>
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
        <Card title={t('Database')} hint={t('Tables, views, forms and dashboards in one database.')} icon={<Icon name="database" />} sample="table" onClick={() => onPick(DATABASE_TEMPLATE)} />
        <Card title={t('Drawing')} hint={t('A blank whiteboard for sketches and diagrams.')} icon={<Icon name="pencil" />} sample="draw" onClick={() => onPick(BOARD_TEMPLATE)} />
        {list.map((tp) => (
          <Card key={tp.id} title={tp.title} hint={tp.desc} icon={<Glyph name={TEMPLATE_GLYPH[tp.id] ?? 'page'} size={17} />} sample={SAMPLE[tp.id] ?? 'doc'} onClick={() => onPick(tp.id)} />
        ))}
      </div>
    </div>
  )
}
