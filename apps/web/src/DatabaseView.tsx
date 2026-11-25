import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { t } from './i18n'
import { commandMatches } from './shortcutCommands'
import { InvalidCell, boardColumns, cellFields, addOption, addProperty, createRow, createView, formatDateFa, patchViewConfig, readViewConfig, removeOption, renameProperty, setCell, setMembers, setViewConfig, trashProperty, trashRow, trashView, viewRows, PROP_TYPES, titleProperty, type CellValue, type DatabaseModel, type PropertyModel, type PropType, type RowModel, type ViewModel } from '@nevis/core'
import { BoardView } from './BoardView'
import { DatabasePresentations, databasePresentation, valueText } from './DatabasePresentations'
import { DatabaseToolbar, KIND_ICON } from './DatabaseToolbar'
import { Button, Checkbox, Dropdown, Icon, IconButton, useMenu, type MenuItem } from './ds'
import { ColumnResize } from './ColumnResize'
import { DatabaseDatePicker } from './DatabaseDatePicker'
import { go, href } from './router'
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

function TextCell({ stored, onCommit, kind, label, settings, propertyField }: { settings: SyncedSettings; stored: string; onCommit: (v: string) => Promise<void>; kind: 'text' | 'url' | 'number' | 'date'; label: string; propertyField?: boolean }) {
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
    <input aria-label={label} dir={kind === 'text' ? 'auto' : 'ltr'} className={[propertyField && 'ds-field', error && 'bad'].filter(Boolean).join(' ')} value={shown} title={error || undefined}
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

export function Cell({ ws, db, p, row, onWrite, propertyField }: { ws: Workspace; db: DatabaseModel; p: PropertyModel; row: RowModel; propertyField?: boolean; onWrite?: (row: RowModel, p: PropertyModel, value: CellValue) => Promise<void> }) {
  const stored: CellValue = row.cells[p.id] ?? null
  const [v, setV] = useOptimistic<CellValue>(stored)
  const write = (value: string | boolean | null) => onWrite ? onWrite(row, p, value) : ws.mutate([row.id], c => setCell(c, row.id, p, value)).then(() => {})
  const members = (id: string, on: boolean) => {
    const cur = new Set(v as string[])
    if (on) cur.add(id); else cur.delete(id)
    setV([...cur].sort(), () => onWrite ? onWrite(row, p, [...cur].sort()) : ws.mutate([row.id], c => setMembers(c, row.id, p.id, { [id]: on })))
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
    default: return <TextCell propertyField={propertyField} settings={readSynced(ws)} stored={typeof v === 'string' ? v : ''} kind={p.type} label={p.name} onCommit={async s => { await write(s) }} />
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
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [phoneTable, setPhoneTable] = useState(false)
  useEffect(() => { const m = matchMedia('(max-width: 760px)'); const update = () => setNarrow(m.matches); m.addEventListener('change', update); return () => m.removeEventListener('change', update) }, [])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const resizeGeneration = useRef(0)
  const resizeWrites = useRef<Promise<void>>(Promise.resolve())
  const [resizePreview, setResizePreview] = useState<{ id: string; width: number } | null>(null)
  const [columnOffsets, setColumnOffsets] = useState<number[]>([])
  const [gridError, setGridError] = useState('')
  const [cellSelection, setCellSelection] = useState<{ anchor: [number, number]; active: [number, number] } | null>(null)
  const history = useRef<Array<Array<{ rowId: string; propId: string; before: CellValue; after: CellValue }>>>([])
  const tableRef = useRef<HTMLTableElement>(null)
  const pendingWrites = useRef<Promise<void>>(Promise.resolve())
  const { open: openMenu, menu } = useMenu()
  const [title, setTitle] = useState(db?.title ?? '')
  const [activeView, setActiveView] = useState('')
  useEffect(() => {
    const table = tableRef.current
    if (!table) return
    const measure = () => {
      const headers = [...table.querySelectorAll<HTMLElement>('thead th')].filter(th => th.classList.contains('dbtable-handle') || th.hasAttribute('data-prop'))
      let offset = 0
      const next = headers.map(header => { const current = offset; offset += header.getBoundingClientRect().width; return current })
      setColumnOffsets(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    const observer = new ResizeObserver(measure)
    table.querySelectorAll('thead th').forEach(th => observer.observe(th))
    measure()
    return () => observer.disconnect()
  })
  useEffect(() => setTitle(ws.data.databases.get(id)?.title ?? ''), [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!db) return <p className="small">{t('Loading…')}</p>
  const views = db.views.filter(v => !v.trashed)
  const view = views.find(v => v.id === activeView) ?? views[0]
  const config = readViewConfig(view?.config, db.properties)
  const presentation = view ? databasePresentation(view) : 'table'
  const liveProps = db.properties.filter(p => !p.trashed)
  const orderedProps = [...config.columnOrder.map(id => liveProps.find(p => p.id === id)).filter((p): p is PropertyModel => !!p), ...liveProps.filter(p => !config.columnOrder.includes(p.id))]
  const props = orderedProps.filter(p => !(view?.type === 'table' && config.hidden.includes(p.id)))
  const previewProps = props.filter(p => !p.isTitle).slice(0, 4)
  const frozenIndex = props.findIndex(p => p.id === config.frozenThrough)
  const frozenStyle = (index: number) => index <= frozenIndex ? { insetInlineStart: columnOffsets[index + 1] ?? 0 } : undefined
  const q = search.trim().toLowerCase()
  const rows = viewRows(db.rows, db.properties, config).filter(r => !q || (r.title ?? '').toLowerCase().includes(q) || Object.values(r.cells).some(v => typeof v === 'string' && v.toLowerCase().includes(q)))
  const tp = titleProperty(db.properties)
  const openFullRow = (rowId: string) => go({ name: 'row', db: id, id: rowId })
  const addRow = (open = false) => void ws.mutate([id], c => createRow(c, db)).then(rowId => { if (open) openFullRow(rowId) })
  const grouped = config.groupBy && db.properties.some(p => p.id === config.groupBy && p.type === 'select' && !p.trashed)
  const rowIndexes = new Map(rows.map((row, index) => [row.id, index]))
  const groups = grouped ? boardColumns(rows, db.properties, config).filter(group => group.rows.length) : [{ id: '', name: '', rows }]
  // Keyboard coordinates follow the rendered order, including grouped views.
  const tableRows = groups.flatMap(group => group.rows)
  const gridRowIndexes = new Map(tableRows.map((row, index) => [row.id, index]))
  const valueAt = (row: RowModel, p: PropertyModel): CellValue => row.cells[p.id] ?? null
  const sameValue = (a: CellValue, b: CellValue) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b)
  const applyValues = async (changes: Array<{ row: RowModel; p: PropertyModel; value: CellValue }>, record = true) => {
    const entries: Array<{ rowId: string; propId: string; before: CellValue; after: CellValue }> = []
    const writes: Array<{ ent: string; set: ReturnType<typeof cellFields> }> = []
    for (const { row, p, value } of changes) {
      const currentRow = ws.data.databases.get(id)?.rows.find(item => item.id === row.id) ?? row
      const before = valueAt(currentRow, p)
      if (sameValue(before, value)) continue
      let set: ReturnType<typeof cellFields>
      if (p.type === 'multiSelect' || p.type === 'relation') {
        const previous = Array.isArray(before) ? before : []
        const next = Array.isArray(value) ? value : []
        set = Object.fromEntries([...new Set([...previous, ...next])].map(member => [`c:${p.id}/${member}`, next.includes(member)]))
      } else set = cellFields(p, value as string | boolean | null)
      writes.push({ ent: row.id, set })
      entries.push({ rowId: row.id, propId: p.id, before, after: value })
    }
    if (!writes.length) return
    // All local records and their outbox entries commit together; remote peers can observe separate operations.
    await ws.mutate([...new Set(writes.map(write => write.ent))], c => c.setFieldsMany(writes))
    for (const entry of entries) {
      const row = ws.data.databases.get(id)?.rows.find(r => r.id === entry.rowId)
      const prop = ws.data.databases.get(id)?.properties.find(p => p.id === entry.propId)
      if (row && prop) entry.after = valueAt(row, prop)
    }
    if (record) history.current.push(entries)
  }
  const writeValues = (changes: Parameters<typeof applyValues>[0], record = true) => {
    const write = pendingWrites.current.then(() => applyValues(changes, record))
    pendingWrites.current = write.catch(() => {})
    return write
  }
  const focusCell = (r: number, c: number, extend = false) => {
    if (!tableRows.length || !props.length) return
    const next: [number, number] = [Math.max(0, Math.min(r, tableRows.length - 1)), Math.max(0, Math.min(c, props.length - 1))]
    setCellSelection(current => ({ anchor: extend && current ? current.anchor : next, active: next }))
    tableRef.current?.querySelector<HTMLElement>(`[data-grid-row="${next[0]}"][data-grid-col="${next[1]}"]`)?.focus()
  }
  const bounds = cellSelection && {
    r1: Math.min(cellSelection.anchor[0], cellSelection.active[0]), r2: Math.max(cellSelection.anchor[0], cellSelection.active[0]),
    c1: Math.min(cellSelection.anchor[1], cellSelection.active[1]), c2: Math.max(cellSelection.anchor[1], cellSelection.active[1]),
  }
  const handleGridKey = (event: React.KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement
    if (!target.matches('td[data-grid-row]') || event.nativeEvent.isComposing || !cellSelection || !bounds) return
    const [r, c] = cellSelection.active
    const mod = event.metaKey || event.ctrlKey
    if (commandMatches(event.nativeEvent, 'Select all database cells')) {
      event.preventDefault(); setCellSelection({ anchor: [0, 0], active: [tableRows.length - 1, props.length - 1] }); return
    }
    if (commandMatches(event.nativeEvent, 'Undo database edit')) {
      event.preventDefault()
      const undo = pendingWrites.current.then(async () => {
        const entry = history.current.at(-1)
        if (!entry) return
        const current = ws.data.databases.get(id)
        const changes = entry.map(item => ({ row: current?.rows.find(row => row.id === item.rowId), p: current?.properties.find(p => p.id === item.propId), item }))
        // Do not overwrite a value changed since this edit.
        if (changes.some(({ row, p, item }) => !row || !p || !sameValue(valueAt(row, p), item.after))) { setGridError(t('Some fields changed since; undo was not applied.')); return }
        history.current.pop()
        await applyValues(changes.map(({ row, p, item }) => ({ row: row!, p: p!, value: item.before })), false)
      })
      pendingWrites.current = undo.catch(error => { setGridError(String(error)) })
      return
    }
    const fill = commandMatches(event.nativeEvent, 'Fill down')
    if (fill || commandMatches(event.nativeEvent, 'Clear database cells')) {
      event.preventDefault()
      const changes: Array<{ row: RowModel; p: PropertyModel; value: CellValue }> = []
      for (let ri = bounds.r1 + (fill ? 1 : 0); ri <= bounds.r2; ri++) for (let ci = bounds.c1; ci <= bounds.c2; ci++) {
        const row = tableRows[ri], p = props[ci], source = tableRows[bounds.r1]
        if (row && p && source && !p.isTitle) changes.push({ row, p, value: fill ? valueAt(source, p) : p.type === 'checkbox' ? false : p.type === 'multiSelect' || p.type === 'relation' ? [] : null })
      }
      void writeValues(changes).catch(error => setGridError(String(error))); return
    }
    if (commandMatches(event.nativeEvent, 'Edit database cell')) {
      event.preventDefault()
      target.querySelector<HTMLElement>('input, button, summary, select, textarea')?.focus(); return
    }
    if (mod || event.altKey) return
    const direction: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const delta = direction[event.key]
    if (delta) { event.preventDefault(); focusCell(r + delta[0], c + delta[1], event.shiftKey) }
  }
  const picked = rows.filter(row => selected.has(row.id))
  const toggleRow = (rowId: string, on: boolean) => setSelected(current => {
    const next = new Set(current)
    if (on) next.add(rowId)
    else next.delete(rowId)
    return next
  })
  const rowItems = (rowId: string): MenuItem[] => [
    { label: 'Open in side peek', testid: 'db-menu-peek', icon: <Icon name="panel-right" size={16} className="ds-flip" />, onSelect: () => onPeek(rowId) },
    { label: 'Open as full page', testid: 'db-menu-full', icon: <Icon name="maximize" size={16} />, onSelect: () => openFullRow(rowId) },
    { label: 'Copy link', icon: <Icon name="link" size={16} />, onSelect: async () => {
      try {
        const link = new URL(href({ name: 'row', db: id, id: rowId }), location.href)
        await navigator.clipboard.writeText(link.href)
        ws.notify(t('Copied'))
      } catch { ws.notify(t('Could not access the clipboard. Use the keyboard shortcut instead.')) }
    } },
    ...(presentation === 'table' ? [{ label: 'Select item', kind: 'item' as const, checked: selected.has(rowId), onSelect: () => toggleRow(rowId, !selected.has(rowId)) }] : []),
    { kind: 'sep' },
    { label: 'Delete row', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => {
      toggleRow(rowId, false)
      void ws.mutate([rowId], c => trashRow(c, rowId)).catch(() => ws.notify(t('Could not complete the action. Please try again.')))
    } },
  ]
  const openRowContext = (rowId: string, event: MouseEvent) => {
    const target = event.target as Element
    if (!event.currentTarget.contains(target) || target.closest('input:not([type="checkbox"]):focus, textarea, [contenteditable="true"]')) return
    openMenu(rowItems(rowId), event)
  }
  const saveView = (patch: Parameters<typeof patchViewConfig>[1]) => view && ws.mutate([view.id], c => setViewConfig(c, view.id, patchViewConfig(view.config, patch)))
  const previewWidth = (id: string, width: number | null) => {
    resizeGeneration.current++
    setResizePreview(width === null ? null : { id, width })
  }
  const saveWidth = (propId: string, width: number | null) => {
    if (!view) return
    const viewId = view.id
    const generation = ++resizeGeneration.current
    setResizePreview(width === null ? null : { id: propId, width })
    // Serialize rapid keyboard changes and patch the latest config at the time of each write.
    resizeWrites.current = resizeWrites.current.then(async () => {
      const current = ws.data.databases.get(id)?.views.find(item => item.id === viewId)
      if (!current) throw new Error('View no longer exists')
      const widths = { ...readViewConfig(current.config, ws.data.databases.get(id)?.properties).columnWidths }
      if (width === null) delete widths[propId]; else widths[propId] = width
      await ws.mutate([viewId], c => setViewConfig(c, viewId, patchViewConfig(current.config, { columnWidths: widths })))
    }).catch(() => { ws.notify(t('Could not complete the action. Please try again.')) }).finally(() => {
      if (resizeGeneration.current === generation) setResizePreview(null)
    })
  }
  const moveColumn = (p: PropertyModel, delta: number) => {
    const index = props.findIndex(prop => prop.id === p.id), target = props[index + delta]
    if (!target || p.isTitle || target.isTitle) return
    const ids = orderedProps.map(prop => prop.id)
    const from = ids.indexOf(p.id), to = ids.indexOf(target.id)
    ids.splice(from, 1); ids.splice(to, 0, p.id)
    setCellSelection(null)
    void saveView({ columnOrder: ids })
  }
  const colItems = (p: PropertyModel): MenuItem[] => [
    { label: t('Move column earlier'), disabled: props.findIndex(prop => prop.id === p.id) <= 1 || p.isTitle, onSelect: () => moveColumn(p, -1) },
    { label: t('Move column later'), disabled: props.findIndex(prop => prop.id === p.id) < 0 || props.findIndex(prop => prop.id === p.id) >= props.length - 1 || p.isTitle, onSelect: () => moveColumn(p, 1) },
    { label: config.frozenThrough === p.id ? t('Unfreeze columns') : t('Freeze through this column'), onSelect: () => void saveView({ frozenThrough: config.frozenThrough === p.id ? '' : p.id }) },
    { kind: 'sep' },
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
      {gridError && <p className="err" role="alert">{gridError}</p>}
      {view && <DatabaseToolbar ws={ws} db={db} view={view} onActive={setActiveView} search={search} onSearch={setSearch} onNewRow={() => addRow()} onNewPageRow={() => addRow(true)} onDelete={() => { void ws.trash(id); go({ name: 'home' }) }} />}
      {narrow && presentation === 'table' && <div className="mobile-db-mode"><button type="button" data-testid="mobile-db-mode" onClick={() => setPhoneTable(value => !value)}><Icon name={phoneTable ? 'list' : 'table'} size={16} />{t(phoneTable ? 'Show records' : 'Show table')}</button></div>}
      {narrow && presentation === 'table' && !phoneTable ? <div className="mobile-db-list" data-testid="mobile-db-list">
        {rows.length === 0 ? <p className="mobile-db-empty">{t('Nothing here yet')}</p> : groups.map(group => <section key={group.id}>
          {grouped && <h3 className="dv-section-head" dir="auto">{group.name || t('No value')}</h3>}
          {group.rows.map(row => <button type="button" className="mobile-db-row" data-testid="mobile-db-row" key={row.id} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onPeek(row.id) }}>
            <span className="mobile-db-row-title" dir="auto">{row.title || t('Untitled')}</span>
            <span className="mobile-db-row-values">{previewProps.map(p => ({ p, text: valueText(ws, p, row) })).filter(v => v.text).slice(0, 2).map(({ p, text }) => <span key={p.id} dir="auto">{p.name}: {text}</span>)}</span>
            <Icon name="chevron-right" size={16} className="ds-flip" />
          </button>)}
        </section>)}
      </div> : presentation === 'board' ? <BoardView ws={ws} db={db} config={config} rows={rows} titleProp={tp} onPeek={onPeek} onItemMenu={openRowContext} /> : presentation === 'list' || presentation === 'gallery' ? <DatabasePresentations ws={ws} presentation={presentation} groups={groups} grouped={!!grouped} props={props} onPeek={onPeek} onItemMenu={openRowContext} onNew={() => { void ws.mutate([id], c => createRow(c, db)).then(onPeek) }} /> : (
      <div className="dv-table-wrap dbtable-wrap">
        {picked.length > 0 && <div className="dv-bulk"><b>{t('{n} selected', { n: picked.length })}</b><Button size="sm" variant="danger" onClick={() => {
          setSelected(new Set())
          void ws.mutate(picked.map(row => row.id), async client => {
            for (const row of picked) await trashRow(client, row.id)
          })
        }}>{t('Delete')}</Button></div>}
        <table ref={tableRef} className="dbtable" data-testid="db-table" onKeyDown={handleGridKey}>
          <thead>
            <tr>
              <th className="dbtable-handle" data-frozen={frozenIndex >= 0 || undefined} style={frozenIndex >= 0 ? { insetInlineStart: 0 } : undefined}><Checkbox label={t('Select all')} checked={rows.length > 0 && picked.length === rows.length} disabled={!rows.length} onChange={on => setSelected(new Set(on ? rows.map(row => row.id) : []))} /></th>
              {props.map((p, ci) => (
                <th key={p.id} onContextMenu={e => { if (!(e.target as Element).closest('input, [role="separator"]')) openMenu(colItems(p), e) }} data-prop={p.name} data-title={p.isTitle || undefined} data-frozen={ci <= frozenIndex || undefined} style={{ ...frozenStyle(ci), ...((resizePreview?.id === p.id || config.columnWidths[p.id] !== undefined) ? { inlineSize: resizePreview?.id === p.id ? resizePreview.width : config.columnWidths[p.id], minInlineSize: resizePreview?.id === p.id ? resizePreview.width : config.columnWidths[p.id] } : {}) }}>
                  <button type="button" className="dv-th-btn" data-testid="col-head" aria-haspopup="menu" onClick={e => openMenu(colItems(p), e.currentTarget)}>
                    <span className="dv-kind"><Icon name={KIND_ICON[p.type]} size={15} /></span>
                    <span className="dv-th-name" dir="auto">{p.name}</span>
                    {config.sort[0]?.prop === p.id && <Icon name={config.sort[0].dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} className="dv-th-sort" />}
                  </button>
                  <ColumnResize name={p.name} width={resizePreview?.id === p.id ? resizePreview.width : config.columnWidths[p.id] ?? (p.isTitle ? 320 : 280)} onPreview={width => previewWidth(p.id, width)} onCommit={width => saveWidth(p.id, width)} onReset={() => saveWidth(p.id, null)} />
                  {(p.type === 'select' || p.type === 'multiSelect') && <OptionAdder ws={ws} p={p} />}
                </th>
              ))}
              <th className="dbtable-add"><button type="button" className="dv-th-btn" data-testid="col-add" aria-label={t('Add property')} title={t('Add property')} onClick={() => window.dispatchEvent(new Event('nevis:db-props'))}><Icon name="plus" size={16} /></button></th>
            </tr>
          </thead>
          {groups.map(group => <tbody key={group.id}>
            {grouped && <tr><th scope="rowgroup" colSpan={props.length + 2} className="dbtable-group"><span dir="auto">{group.name || t('No value')}</span><span className="ds-badge">{group.rows.length}</span></th></tr>}
            {group.rows.map(r => (
              <tr key={r.id} data-testid="db-row" data-id={r.id} data-checked={selected.has(r.id) || undefined} tabIndex={0} onContextMenu={e => openRowContext(r.id, e)}
                onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onPeek(r.id) } }}
                onClick={event => {
                  const target = event.target as Element
                  if (!event.currentTarget.contains(target) || target.closest('.dbtable-handle, button, a, label, select, textarea, summary')) return
                  if (target.closest('input') && !target.closest('[data-kind="title"]')) return
                  const selection = window.getSelection()
                  if (selection?.anchorNode && event.currentTarget.contains(selection.anchorNode) && selection.toString()) return
                  onPeek(r.id)
                }}>
                <td className="dbtable-handle" data-frozen={frozenIndex >= 0 || undefined} style={frozenIndex >= 0 ? { insetInlineStart: 0 } : undefined}>
                  <button type="button" className="dv-grip" aria-label={t('Item actions')} onClick={e => openMenu(rowItems(r.id), e.currentTarget)}><Icon name="more-vertical" size={16} /></button>
                  <Checkbox label={t('Select item')} checked={selected.has(r.id)} onChange={on => toggleRow(r.id, on)} />
                </td>
                {props.map((p, ci) => (
                  <td key={p.id} data-testid="cell" data-prop={p.name} data-row={rowIndexes.get(r.id)} data-grid-row={gridRowIndexes.get(r.id)!} data-grid-col={ci} data-frozen={ci <= frozenIndex || undefined} style={frozenStyle(ci)} tabIndex={0}
                    data-cell-selected={bounds && gridRowIndexes.get(r.id)! >= bounds.r1 && gridRowIndexes.get(r.id)! <= bounds.r2 && ci >= bounds.c1 && ci <= bounds.c2 || undefined}
                    onFocus={event => { if (event.target === event.currentTarget) setCellSelection(current => current?.active[0] === gridRowIndexes.get(r.id)! && current.active[1] === ci ? current : { anchor: [gridRowIndexes.get(r.id)!, ci], active: [gridRowIndexes.get(r.id)!, ci] }) }}>
                    <span className="db-cellbox" data-kind={p.isTitle ? 'title' : undefined}>
                      {p.isTitle && <Icon name="file" size={16} className="dbcell-file" />}
                      <Cell ws={ws} db={db} p={p} row={r} onWrite={(row, prop, value) => writeValues([{ row, p: prop, value }])} />
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
      {menu}
      </div>
    </section></div>
  )
}
