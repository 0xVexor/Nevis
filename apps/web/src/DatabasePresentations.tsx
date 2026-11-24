import { formatDateFa, type PropertyModel, type RowModel, type ViewModel } from '@nevis/core'
import { Icon } from './ds'
import { t } from './i18n'
import { PageIcon } from './shell/PageIcon'
import type { Workspace } from './workspace'
import { readSynced } from './workspaceSettings'

export type DatabasePresentation = 'table' | 'board' | 'list' | 'gallery'

/** List and gallery are additive table presentations, so older clients can still open the view. */
export function databasePresentation(view: ViewModel): DatabasePresentation {
  if (view.type === 'board') return 'board'
  const config = view.config
  if (config && typeof config === 'object' && !Array.isArray(config) && (config.presentation === 'list' || config.presentation === 'gallery')) return config.presentation
  return 'table'
}

type Group = { id: string; name: string; rows: RowModel[] }

function valueText(ws: Workspace, prop: PropertyModel, row: RowModel): string {
  const value = row.cells[prop.id]
  if (prop.type === 'checkbox') return value === true ? '☑' : '☐'
  if (prop.type === 'select') return prop.options.find(option => option.id === value)?.name ?? ''
  if (prop.type === 'multiSelect' && Array.isArray(value)) return value.map(id => prop.options.find(option => option.id === id)?.name).filter(Boolean).join('، ')
  if (prop.type === 'relation' && Array.isArray(value)) {
    const config = prop.config
    const target = config && typeof config === 'object' && !Array.isArray(config) && typeof config.target === 'string' ? config.target : row.db
    const rows = ws.data.databases.get(target)?.rows ?? []
    return value.map(id => rows.find(r => r.id === id && !r.trashed)?.title).filter(Boolean).join('، ')
  }
  if (typeof value !== 'string') return ''
  return prop.type === 'date' && readSynced(ws).calendar === 'jalali' ? formatDateFa(value) : value
}

/** Shared rows, sorting, filters, grouping and property visibility come from the database view. */
export function DatabasePresentations({ ws, presentation, groups, grouped, props, onPeek, onNew }: {
  ws: Workspace; presentation: 'list' | 'gallery'; groups: Group[]; grouped: boolean; props: PropertyModel[]; onPeek: (id: string) => void; onNew: () => void
}) {
  const visible = props.filter(prop => !prop.isTitle).slice(0, 4)
  const count = groups.reduce((n, group) => n + group.rows.length, 0)
  const item = (row: RowModel) => {
    const title = row.title || t('Untitled')
    const values = visible.map(prop => ({ prop, text: valueText(ws, prop, row) })).filter(item => item.text)
    const icon = <PageIcon page={{ id: row.id }} />
    return presentation === 'list' ? (
      <div className="ds-list-row dv-listrow dv-stretch" key={row.id} data-testid="db-list-row">
        <button type="button" className="dv-stretch-hit" aria-label={title} onClick={() => onPeek(row.id)} />
        {icon}<span className="dv-listrow-title" dir="auto">{title}</span>
        <span className="dv-listrow-props">{values.map(({ prop, text }) => <span className="dv-listrow-prop" key={prop.id} title={prop.name} dir="auto">{text}</span>)}</span>
      </div>
    ) : (
      <div className="dv-card dv-stretch" key={row.id} data-testid="db-gallery-card">
        <button type="button" className="dv-stretch-hit" aria-label={title} onClick={() => onPeek(row.id)} />
        <div className="dv-card-title">{icon}<span dir="auto">{title}</span></div>
        {values.length > 0 && <div className="dv-card-props">{values.map(({ prop, text }) => <span className="dv-card-prop" key={prop.id} title={prop.name} dir="auto">{text}</span>)}</div>}
      </div>
    )
  }
  return (
    <div className={presentation === 'list' ? 'dv-list' : 'dv-gallery'} data-testid={`db-${presentation}`}>
      {count === 0 ? <div className="ds-empty ds-empty--framed"><b>{t('Nothing here yet')}</b><span>{t('Add the first item.')}</span></div> : groups.map(group => (
        <section key={group.id}>
          {grouped && <h3 className="dv-section-head"><span dir="auto">{group.name || t('No value')}</span><span className="ds-badge">{group.rows.length}</span></h3>}
          <div className={presentation === 'list' ? 'ds-list ds-list--framed' : 'dv-gallery-grid'}>{group.rows.map(item)}</div>
        </section>
      ))}
      <button type="button" className="dv-newline" data-testid="db-presentation-add" onClick={onNew}><Icon name="plus" size={15} />{t('New item')}</button>
    </div>
  )
}
