import { useEffect, useRef, useState } from 'react'
import { t } from './i18n'
import { InvalidCell, boardColumns, addOption, addProperty, createRow, createView, formatDateFa, patchViewConfig, readViewConfig, removeOption, renameProperty, setCell, setMembers, setViewConfig, trashProperty, trashRow, trashView, viewRows, PROP_TYPES, titleProperty, type CellValue, type DatabaseModel, type PropertyModel, type PropType, type RowModel, type ViewModel } from '@nevis/core'
import { BoardView } from './BoardView'
import { DatabaseToolbar, KIND_ICON } from './DatabaseToolbar'
import { Button, Checkbox, Dropdown, Icon, IconButton, Menu, useMenu, type MenuItem } from './ds'
import { DatabaseDatePicker } from './DatabaseDatePicker'
import { go } from './router'
import { promptDialog } from './dialog'
import type { Workspace } from './workspace'
import { readSynced, type SyncedSettings } from './workspaceSettings'

const typeNames = (): Record<PropType, string> => ({ text: t('Text'), number: t('Number'), date: t('Date'), select: t('Select'), multiSelect: t('Multi-select'), relation: t('Relation'), checkbox: t('Checkbox'), url: t('Link') })
const THROTTLE_MS = 400

/** A text-like cell: typing is written at most every 400 ms, and at once on blur or Enter (the same rule as page titles). */
function useDraft(stored: string, commit: (v: string) => Promise<void> | void) {
  const [draft, setDraft] = useState(stored)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(draft)
  useEffect(() => { if (!dirty.current) setDraft(stored) }, [stored])
  const flush = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; if (dirty.current) { dirty.current = false; void commit(latest.current) } }
  const change = (v: string, live: boolean) => {
    latest.current = v; dirty.current = true; setDraft(v)
    if (live && !timer.current) timer.current = setTimeout(flush, THROTTLE_MS)
  }
  return { draft, change, flush }
}

function TextCell({ stored, onCommit, kind, label, settings }: { settings: SyncedSettings; stored: string; onCommit: (v: string) => Promise<void>; kind: 'text' | 'url' | 'number' | 'date'; label: string }) {
  const [error, setError] = useState('')
  const [focus, setFocus] = useState(false)
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null)
  const dateField = useRef<HTMLSpanElement>(null)
  const calendarButton = useRef<HTMLButtonElement>(null)
  const normalized = kind === 'number' || kind === 'date'
  const commit = async (v: string) => {
    try { await onCommit(v); setError('') } catch (e) { setError(e instanceof InvalidCell ? (kind === 'number' ? t('Invalid number') : t('Invalid date')) : String(e)) }
  }
  const { draft, change, flush } = useDraft(stored, commit)
  // a date is SHOWN in the Persian calendar and edited in the stored (Gregorian) form
  const shown = kind === 'date' && !focus && stored && draft === stored && settings.calendar === 'jalali' ? formatDateFa(stored) : draft
  const openDate = () => { if (dateField.current) setDateAnchor(dateField.current.getBoundingClientRect()) }
  const closeDate = () => {
    if (document.activeElement?.closest('.dv-date-picker')) calendarButton.current?.focus()
    setDateAnchor(null)
  }
  const input = (
    <input aria-label={label} dir={kind === 'text' ? 'auto' : 'ltr'} className={error ? 'bad' : ''} value={shown} title={error || undefined}
      onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); flush() }} onClick={kind === 'date' ? openDate : undefined}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onChange={e => change(e.target.value, !normalized)} />
  )
  return (
    <>
      {kind === 'date' ? <span className="dv-date-field" ref={dateField}>
        {input}
        <IconButton ref={calendarButton} label={t('Calendar')} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={() => dateAnchor ? closeDate() : openDate()}><Icon name="calendar" size={15} /></IconButton>
      </span> : input}
      {dateAnchor && <DatabaseDatePicker anchor={dateAnchor} stored={stored} settings={settings} onClose={closeDate} onSelect={value => { change(value, false); flush(); closeDate() }} />}
      {error && <span className="err small" role="alert">{error}</span>}
    </>
  )
}

/** What the person just chose is shown at once; the stored value takes over when the write has been read back (no flicker). */
function useOptimistic<T>(stored: T) {
  const [local, setLocal] = useState<{ v: T } | null>(null)
  const set = (v: T, write: () => Promise<unknown>) => { setLocal({ v }); void write().finally(() => setLocal(null)) }
  return [local ? local.v : stored, set] as const
}

export function Cell({ ws, db, p, row }: { ws: Workspace; db: DatabaseModel; p: PropertyModel; row: RowModel }) {
  const stored: CellValue = row.cells[p.id] ?? null
  const [v, setV] = useOptimistic<CellValue>(stored)
  const write = (value: string | boolean | null) => ws.mutate([row.id], c => setCell(c, row.id, p, value))
  const members = (id: string, on: boolean) => {
    const cur = new Set(v as string[])
    if (on) cur.add(id); else cur.delete(id)
    setV([...cur].sort(), () => ws.mutate([row.id], c => setMembers(c, row.id, p.id, { [id]: on })))
  }
  switch (p.type) {
    case 'checkbox': return (
      <Checkbox label={p.name} checked={v === true} onChange={checked => setV(checked, () => write(checked))} />
    )
    case 'select':
      return (
        <Dropdown label={p.name} value={typeof v === 'string' ? v : ''} options={[{ value: '', label: '—' }, ...p.options.map(o => ({ value: o.id, label: o.name, raw: true, swatch: o.color }))]} onChange={value => setV(value || null, () => write(value || null))} />
      )
    case 'multiSelect':
      return (
        <span className="chips">
          {p.options.map(o => (
            <Checkbox key={o.id} checked={Array.isArray(v) && v.includes(o.id)} onChange={checked => members(o.id, checked)}>{o.name}</Checkbox>
          ))}
        </span>
      )
    case 'relation': {
      const targetId = p.config && typeof p.config === 'object' && !Array.isArray(p.config) && typeof p.config.target === 'string' ? p.config.target : db.id
      const target = ws.data.databases.get(targetId)
      const chosen = (v ?? []) as string[]
      return (
        <details>
          <summary>{chosen.length ? chosen.map(id => target?.rows.find(r => r.id === id)?.title || '…').join('، ') : '—'}</summary>
          {(target?.rows ?? []).filter(r => !r.trashed).map(r => (
            <Checkbox key={r.id} checked={chosen.includes(r.id)} onChange={checked => members(r.id, checked)}>{r.title || t('Untitled')}</Checkbox>
          ))}
        </details>
      )
    }
    default: return <TextCell settings={readSynced(ws)} stored={typeof v === 'string' ? v : ''} kind={p.type} label={p.name} onCommit={async s => { await write(s) }} />
  }
}

function OptionAdder({ ws, p }: { ws: Workspace; p: PropertyModel }) {
  const [name, setName] = useState('')
  const add = async () => { const n = name.trim(); if (!n) return; setName(''); await ws.mutate([p.id], c => addOption(c, p.id, { name: n })) }
  return (
    <span className="optadd">
      <span className="optadd-entry">
        <input className="ds-field" aria-label={t('New option for {name}', { name: p.name })} data-testid="opt-name" placeholder={t('New option')} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add() }} />
        <button type="button" className="ds-icon-btn" aria-label={t('New option')} data-testid="opt-add" onClick={() => void add()}><Icon name="plus" size={14} /></button>
      </span>
      {p.options.map(o => <button key={o.id} className="tiny" title={t('Remove option')} onClick={() => void ws.mutate([p.id], c => removeOption(c, p.id, o.id))}>{o.name} ✕</button>)}
    </span>
  )
}

/** The editable table view of one database (M7), with the views, sort, hidden columns and boards of M8b. */
export function DatabaseView({ ws, id, onPeek }: { ws: Workspace; id: string; onPeek: (rowId: string) => void }) {
  const db = ws.data.databases.get(id)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const rowMenu = useMenu()
  const [colMenu, setColMenu] = useState<{ rect: DOMRect; p: PropertyModel } | null>(null)
  const [title, setTitle] = useState(db?.title ?? '')
  const [activeView, setActiveView] = useState('')
  useEffect(() => setTitle(ws.data.databases.get(id)?.title ?? ''), [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!db) return <p className="small">{t('Loading…')}</p>
  const views = db.views.filter(v => !v.trashed)
  const view = views.find(v => v.id === activeView) ?? views[0]
  const config = readViewConfig(view?.config, db.properties)
  const props = db.properties.filter(p => !p.trashed && !(view?.type === 'table' && config.hidden.includes(p.id)))
  const q = search.trim().toLowerCase()
  const rows = viewRows(db.rows, db.properties, config).filter(r => !q || (r.title ?? '').toLowerCase().includes(q) || Object.values(r.cells).some(v => typeof v === 'string' && v.toLowerCase().includes(q)))
  const tp = titleProperty(db.properties)
  const openFullRow = (rowId: string) => go({ name: 'row', db: id, id: rowId })
  const addRow = (open = false) => void ws.mutate([id], c => createRow(c, db)).then(rowId => { if (open) openFullRow(rowId) })
  const grouped = config.groupBy && db.properties.some(p => p.id === config.groupBy && p.type === 'select' && !p.trashed)
  const rowIndexes = new Map(rows.map((row, index) => [row.id, index]))
  const groups = grouped ? boardColumns(rows, db.properties, config).filter(group => group.rows.length) : [{ id: '', name: '', rows }]
  const picked = rows.filter(row => selected.has(row.id))
  const toggleRow = (rowId: string, on: boolean) => setSelected(current => {
    const next = new Set(current)
    if (on) next.add(rowId)
    else next.delete(rowId)
    return next
  })
  const saveView = (patch: Parameters<typeof patchViewConfig>[1]) => view && ws.mutate([view.id], c => setViewConfig(c, view.id, patchViewConfig(view.config, patch)))
  const colItems = (p: PropertyModel): MenuItem[] => [
    { label: t('Rename'), icon: <Icon name="pencil" size={16} />, onSelect: () => void promptDialog({ title: t('Column name'), initial: p.name }).then(n => { if (n?.trim() && n.trim() !== p.name) void ws.mutate([p.id], c => renameProperty(c, p.id, n.trim())) }) },
    { kind: 'sep' },
    { label: t('Sort ascending'), icon: <Icon name="arrow-up" size={16} />, checked: config.sort[0]?.prop === p.id && config.sort[0].dir === 'asc', onSelect: () => void saveView({ sort: [{ prop: p.id, dir: 'asc' }] }) },
    { label: t('Sort descending'), icon: <Icon name="arrow-down" size={16} />, checked: config.sort[0]?.prop === p.id && config.sort[0].dir === 'desc', onSelect: () => void saveView({ sort: [{ prop: p.id, dir: 'desc' }] }) },
    ...(config.sort[0]?.prop === p.id ? [{ label: t('Remove sort'), icon: <Icon name="x" size={16} />, onSelect: () => void saveView({ sort: [] }) } as MenuItem] : []),
    ...(!p.isTitle ? [{ kind: 'sep' } as MenuItem, { label: t('Hide in this view'), icon: <Icon name="eye-off" size={16} />, onSelect: () => void saveView({ hidden: [...config.hidden, p.id] }) } as MenuItem, { label: t('Delete column'), icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => void ws.mutate([p.id], c => trashProperty(c, p.id)) } as MenuItem] : []),
  ]
  return (
    <div className="page-cols dv-page-cols"><section className="page dv-page" data-testid="db-view">
      <header className="dv-page-head"><input className="dv-page-title" data-testid="db-title" dir="auto" aria-label={t('Database title')} value={title} placeholder={t('Untitled database')} onChange={e => { setTitle(e.target.value); ws.setTitle(id, e.target.value) }} />
      <p className="dv-page-line">{t('{n} items', { n: rows.length.toLocaleString() })}</p></header>
      <div className="dv">
      {view && <DatabaseToolbar ws={ws} db={db} view={view} onActive={setActiveView} search={search} onSearch={setSearch} onNewRow={() => addRow()} onNewPageRow={() => addRow(true)} onDelete={() => { void ws.trash(id); go({ name: 'home' }) }} />}
      {view?.type === 'board' ? <BoardView ws={ws} db={db} config={config} rows={rows} titleProp={tp} /> : (
      <div className="dv-table-wrap dbtable-wrap">
        {picked.length > 0 && <div className="dv-bulk"><b>{t('{n} selected', { n: picked.length })}</b><Button size="sm" variant="danger" onClick={() => {
          setSelected(new Set())
          void ws.mutate(picked.map(row => row.id), async client => {
            for (const row of picked) await trashRow(client, row.id)
          })
        }}>{t('Delete')}</Button></div>}
        <table className="dbtable" data-testid="db-table">
          <thead>
            <tr>
              <th className="dbtable-handle"><Checkbox label={t('Select all')} checked={rows.length > 0 && picked.length === rows.length} disabled={!rows.length} onChange={on => setSelected(new Set(on ? rows.map(row => row.id) : []))} /></th>
              {props.map(p => (
                <th key={p.id} data-prop={p.name}>
                  <button type="button" className="dv-th-btn" data-testid="col-head" aria-haspopup="menu" onClick={e => setColMenu({ rect: e.currentTarget.getBoundingClientRect(), p })}>
                    <span className="dv-kind"><Icon name={KIND_ICON[p.type]} size={15} /></span>
                    <span className="dv-th-name" dir="auto">{p.name}</span>
                    {config.sort[0]?.prop === p.id && <Icon name={config.sort[0].dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} className="dv-th-sort" />}
                  </button>
                  {(p.type === 'select' || p.type === 'multiSelect') && <OptionAdder ws={ws} p={p} />}
                </th>
              ))}
              <th className="dbtable-add"><button type="button" className="dv-th-btn" data-testid="col-add" aria-label={t('Add property')} title={t('Add property')} onClick={() => window.dispatchEvent(new Event('nevis:db-props'))}><Icon name="plus" size={16} /></button></th>
            </tr>
          </thead>
          {groups.map(group => <tbody key={group.id}>
            {grouped && <tr><th scope="rowgroup" colSpan={props.length + 2} className="dbtable-group"><span dir="auto">{group.name || t('No value')}</span><span className="ds-badge">{group.rows.length}</span></th></tr>}
            {group.rows.map(r => (
              <tr key={r.id} data-testid="db-row" data-id={r.id} data-checked={selected.has(r.id) || undefined} tabIndex={0}
                onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) onPeek(r.id) }}
                onClick={event => {
                  const target = event.target as Element
                  if (!event.currentTarget.contains(target) || target.closest('.dbtable-handle, button, a, label, select, textarea, summary')) return
                  if (target.closest('input') && !target.closest('[data-kind="title"]')) return
                  const selection = window.getSelection()
                  if (selection?.anchorNode && event.currentTarget.contains(selection.anchorNode) && selection.toString()) return
                  onPeek(r.id)
                }}>
                <td className="dbtable-handle">
                  <button type="button" className="dv-grip" aria-label={t('Item actions')} onClick={e => rowMenu.open([
                    { label: 'Open as page', icon: <Icon name="panel-right" size={16} className="ds-flip" />, onSelect: () => onPeek(r.id) },
                    { label: 'Delete row', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => void ws.mutate([r.id], c => trashRow(c, r.id)) },
                  ], e.currentTarget)}><Icon name="more-vertical" size={16} /></button>
                  <Checkbox label={t('Select item')} checked={selected.has(r.id)} onChange={on => toggleRow(r.id, on)} />
                </td>
                {props.map(p => (
                  <td key={p.id} data-testid="cell" data-prop={p.name} data-row={rowIndexes.get(r.id)}>
                    <span className="db-cellbox" data-kind={p.isTitle ? 'title' : undefined}>
                      {p.isTitle && <Icon name="file" size={16} className="dbcell-file" />}
                      <Cell ws={ws} db={db} p={p} row={r} />
                    </span>
                  </td>
                ))}
                <td className="dbtable-add" />
              </tr>
            ))}
          </tbody>)}
        </table>
        {rows.length === 0 && (
          <div className="ds-empty ds-empty--framed db-empty">
            <b>{t('Nothing here yet')}</b>
            <span>{t('Add the first item.')}</span>
            <button className="ds-btn ds-btn--primary" data-testid="db-empty-add" onClick={() => void ws.mutate([id], c => createRow(c, db))}>{t('New item')}</button>
          </div>
        )}
        {rows.length > 0 && <div className="dv-newrow"><button type="button" onClick={() => addRow()}><Icon name="plus" size={15} />{t('New item')}</button></div>}
        <div className="db-foot">{t('{n} items', { n: rows.length.toLocaleString() })}</div>
      </div>)}
      {colMenu && view && (
        <Menu anchor={colMenu.rect} onClose={() => setColMenu(null)} items={colItems(colMenu.p)} />
      )}
      {rowMenu.menu}
      </div>
    </section></div>
  )
}
