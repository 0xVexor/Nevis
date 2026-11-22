import { useState } from 'react'
import { t } from './i18n'
import { boardColumns, createRow, moveCard, type DatabaseModel, type PropertyModel, type RowModel, type ViewConfig } from '@nevis/core'
import { Button } from './ds'
import type { Workspace } from './workspace'

const COLOR: Record<string, string> = { red: '#fde2e0', blue: '#dbeafe', green: '#dcf5e4', gray: '#eceff1', yellow: '#fff3c4', orange: '#ffe6cc', purple: '#eadcfb', pink: '#fbdcf0' }

/** A board: one column per option of the group-by select property; a card is a row. Dragging a card to a column (or within it) writes the new
 *  option AND the new position in one op. HTML5 drag and drop; every card also has a "move to" menu for touch. */
export function BoardView({ ws, db, config, rows, titleProp }: { ws: Workspace; db: DatabaseModel; config: ViewConfig; rows: RowModel[]; titleProp: PropertyModel | undefined }) {
  const group = db.properties.find(p => p.id === config.groupBy && !p.trashed && p.type === 'select')
  const [over, setOver] = useState<string | null>(null)
  if (!group) return <p className="small" data-testid="board-needs-group">{t('For a board, pick a Select column to group by.')}</p>
  const cols = boardColumns(rows, db.properties, config)
  const move = (rowId: string, option: string, beforeKey: string | null) =>
    ws.mutate([rowId], c => moveCard(c, rowId, group.id, option, beforeKey, null))
  const drop = (option: string, col: { rows: RowModel[] }, e: React.DragEvent) => {
    e.preventDefault(); setOver(null)
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    const target = col.rows.filter(r => r.id !== id)
    void move(id, option, target.length ? target[target.length - 1]!.sortKey : null) // dropped on a column: at its end
  }
  const label = (r: RowModel) => (titleProp ? String(r.cells[titleProp.id] ?? '') : '') || t('Untitled')
  return (
    <div className="db-board" data-testid="board">
      {cols.map(col => (
        <section key={col.id || 'none'} className={'db-board-col' + (over === col.id ? ' over' : '')} data-testid="board-col" data-option={col.id}
          onDragOver={e => { e.preventDefault(); setOver(col.id) }} onDragLeave={() => setOver(o => (o === col.id ? null : o))} onDrop={e => drop(col.id, col, e)}>
          <h3 style={{ background: COLOR[col.color] ?? COLOR.gray }}>{col.id === '' ? t('No value') : col.name} <span className="small">{col.rows.length}</span></h3>
          {col.rows.map(r => (
            <article key={r.id} className="db-board-card" draggable data-testid="board-card" data-id={r.id} onDragStart={e => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move' }}>
              <span dir="auto">{label(r)}</span>
              <select aria-label={t('Move to')} value={col.id} onChange={e => void move(r.id, e.target.value, null)}>
                <option value="">{t('No value')}</option>
                {group.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </article>
          ))}
          <Button size="sm" data-testid="board-add" onClick={() => void ws.mutate([], c => createRow(c, db, { cells: { [`c:${group.id}`]: col.id === '' ? null : col.id } }))}>{t('+ Card')}</Button>
        </section>
      ))}
    </div>
  )
}
