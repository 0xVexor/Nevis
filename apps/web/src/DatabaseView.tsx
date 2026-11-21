import { useEffect, useRef, useState } from 'react'
import { InvalidCell, addOption, addProperty, createRow, createView, formatDateFa, patchViewConfig, readViewConfig, removeOption, renameProperty, setCell, setMembers, setViewConfig, trashProperty, trashRow, trashView, viewRows, PROP_TYPES, titleProperty, type CellValue, type DatabaseModel, type PropertyModel, type PropType, type RowModel, type ViewModel } from '@nevis/core'
import { BoardView } from './BoardView'
import { DatabaseToolbar, KIND_ICON } from './DatabaseToolbar'
import { Icon, Menu, type MenuItem } from './ds'
import { go } from './router'
import type { Workspace } from './workspace'
import { readSynced } from './workspaceSettings'

const TYPE_FA: Record<PropType, string> = { text: 'متن', number: 'عدد', date: 'تاریخ', select: 'انتخاب', multiSelect: 'چندانتخابی', relation: 'ارتباط', checkbox: 'تیک', url: 'پیوند' }
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

function TextCell({ stored, onCommit, kind, label, jalali = true }: { jalali?: boolean; stored: string; onCommit: (v: string) => Promise<void>; kind: 'text' | 'url' | 'number' | 'date'; label: string }) {
  const [error, setError] = useState('')
  const [focus, setFocus] = useState(false)
  const normalized = kind === 'number' || kind === 'date'
  const commit = async (v: string) => {
    try { await onCommit(v); setError('') } catch (e) { setError(e instanceof InvalidCell ? (kind === 'number' ? 'عدد نامعتبر' : 'تاریخ نامعتبر') : String(e)) }
  }
  const { draft, change, flush } = useDraft(stored, commit)
  // a date is SHOWN in the Persian calendar and edited in the stored (Gregorian) form
  const shown = kind === 'date' && !focus && stored && draft === stored && jalali ? formatDateFa(stored) : draft
  return (
    <>
      <input aria-label={label} dir={kind === 'text' ? 'auto' : 'ltr'} className={error ? 'bad' : ''} value={shown} title={error || undefined}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); flush() }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        onChange={e => change(e.target.value, !normalized)} />
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

function Cell({ ws, db, p, row }: { ws: Workspace; db: DatabaseModel; p: PropertyModel; row: RowModel }) {
  const stored: CellValue = row.cells[p.id] ?? null
  const [v, setV] = useOptimistic<CellValue>(stored)
  const write = (value: string | boolean | null) => ws.mutate([row.id], c => setCell(c, row.id, p, value))
  const members = (id: string, on: boolean) => {
    const cur = new Set(v as string[])
    if (on) cur.add(id); else cur.delete(id)
    setV([...cur].sort(), () => ws.mutate([row.id], c => setMembers(c, row.id, p.id, { [id]: on })))
  }
  switch (p.type) {
    case 'checkbox': return <input type="checkbox" aria-label={p.name} checked={v === true} onChange={e => setV(e.target.checked, () => write(e.target.checked))} />
    case 'select':
      return (
        <select aria-label={p.name} value={typeof v === 'string' && p.options.some(o => o.id === v) ? v : ''} onChange={e => setV(e.target.value || null, () => write(e.target.value || null))}>
          <option value="">—</option>
          {p.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )
    case 'multiSelect':
      return (
        <span className="chips">
          {p.options.map(o => (
            <label key={o.id} className="chip"><input type="checkbox" checked={(v as string[]).includes(o.id)} onChange={e => members(o.id, e.target.checked)} />{o.name}</label>
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
            <label key={r.id} className="chip"><input type="checkbox" checked={chosen.includes(r.id)} onChange={e => members(r.id, e.target.checked)} />{r.title || 'بدون عنوان'}</label>
          ))}
        </details>
      )
    }
    default: return <TextCell jalali={readSynced(ws).calendar === 'jalali'} stored={typeof v === 'string' ? v : ''} kind={p.type} label={p.name} onCommit={async s => { await write(s) }} />
  }
}

function OptionAdder({ ws, p }: { ws: Workspace; p: PropertyModel }) {
  const [name, setName] = useState('')
  const add = async () => { const n = name.trim(); if (!n) return; setName(''); await ws.mutate([p.id], c => addOption(c, p.id, { name: n })) }
  return (
    <span className="optadd">
      <input aria-label={`گزینهٔ تازه برای ${p.name}`} data-testid="opt-name" placeholder="گزینهٔ تازه" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add() }} />
      <button data-testid="opt-add" onClick={() => void add()}>＋</button>
      {p.options.map(o => <button key={o.id} className="tiny" title="حذف گزینه" onClick={() => void ws.mutate([p.id], c => removeOption(c, p.id, o.id))}>{o.name} ✕</button>)}
    </span>
  )
}

/** The editable table view of one database (M7), with the views, sort, hidden columns and boards of M8b. */
export function DatabaseView({ ws, id }: { ws: Workspace; id: string }) {
  const db = ws.data.databases.get(id)
  const [search, setSearch] = useState('')
  const [colMenu, setColMenu] = useState<{ rect: DOMRect; p: PropertyModel } | null>(null)
  const [title, setTitle] = useState(db?.title ?? '')
  const [activeView, setActiveView] = useState('')
  useEffect(() => setTitle(ws.data.databases.get(id)?.title ?? ''), [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!db) return <p className="small">در حال بارگذاری…</p>
  const views = db.views.filter(v => !v.trashed)
  const view = views.find(v => v.id === activeView) ?? views[0]
  const config = readViewConfig(view?.config, db.properties)
  const props = db.properties.filter(p => !p.trashed && !(view?.type === 'table' && config.hidden.includes(p.id)))
  const q = search.trim().toLowerCase()
  const rows = viewRows(db.rows, db.properties, config).filter(r => !q || (r.title ?? '').toLowerCase().includes(q) || Object.values(r.cells).some(v => typeof v === 'string' && v.toLowerCase().includes(q)))
  const tp = titleProperty(db.properties)
  const saveView = (patch: Parameters<typeof patchViewConfig>[1]) => view && ws.mutate([view.id], c => setViewConfig(c, view.id, patchViewConfig(view.config, patch)))
  const colItems = (p: PropertyModel): MenuItem[] => [
    { label: 'تغییر نام', icon: <Icon name="pencil" size={16} />, onSelect: () => { const n = window.prompt('نام ستون', p.name); if (n?.trim() && n !== p.name) void ws.mutate([p.id], c => renameProperty(c, p.id, n.trim())) } },
    { kind: 'sep' },
    { label: 'مرتب‌سازی صعودی', icon: <Icon name="arrow-up" size={16} />, checked: config.sort[0]?.prop === p.id && config.sort[0].dir === 'asc', onSelect: () => void saveView({ sort: [{ prop: p.id, dir: 'asc' }] }) },
    { label: 'مرتب‌سازی نزولی', icon: <Icon name="arrow-down" size={16} />, checked: config.sort[0]?.prop === p.id && config.sort[0].dir === 'desc', onSelect: () => void saveView({ sort: [{ prop: p.id, dir: 'desc' }] }) },
    ...(config.sort[0]?.prop === p.id ? [{ label: 'حذف مرتب‌سازی', icon: <Icon name="x" size={16} />, onSelect: () => void saveView({ sort: [] }) } as MenuItem] : []),
    ...(!p.isTitle ? [{ kind: 'sep' } as MenuItem, { label: 'پنهان کردن در این نما', icon: <Icon name="eye-off" size={16} />, onSelect: () => void saveView({ hidden: [...config.hidden, p.id] }) } as MenuItem, { label: 'حذف ستون', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => void ws.mutate([p.id], c => trashProperty(c, p.id)) } as MenuItem] : []),
  ]
  return (
    <section className="pane dv" data-testid="db-view">
      <input className="page-title" data-testid="db-title" value={title} placeholder="پایگاه‌دادهٔ بدون عنوان" onChange={e => { setTitle(e.target.value); ws.setTitle(id, e.target.value) }} />
      <p className="db-count">{rows.length.toLocaleString()} {'مورد'}</p>
      {view && <DatabaseToolbar ws={ws} db={db} view={view} onActive={setActiveView} search={search} onSearch={setSearch} onNewRow={() => void ws.mutate([id], c => createRow(c, db))} onDelete={() => { void ws.trash(id); go({ name: 'home' }) }} />}
      {view?.type === 'board' ? <BoardView ws={ws} db={db} config={config} rows={rows} titleProp={tp} /> : (
      <div className="tablewrap">
        <table className="dbtable" data-testid="db-table">
          <thead>
            <tr>
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
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} data-testid="db-row" data-id={r.id}>
                {props.map(p => <td key={p.id} data-testid="cell" data-prop={p.name} data-row={i}><Cell ws={ws} db={db} p={p} row={r} /></td>)}
                <td><button className="tiny" title="حذف ردیف" onClick={() => void ws.mutate([r.id], c => trashRow(c, r.id))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="ds-empty ds-empty--framed db-empty">
            <b>هنوز چیزی اینجا نیست</b>
            <span>اولین مورد را اضافه کنید.</span>
            <button className="ds-btn ds-btn--primary" data-testid="db-empty-add" onClick={() => void ws.mutate([id], c => createRow(c, db))}>مورد جدید</button>
          </div>
        )}
        <div className="db-foot">{rows.length.toLocaleString()} مورد</div>
      </div>)}
      {colMenu && view && (
        <Menu anchor={colMenu.rect} onClose={() => setColMenu(null)} items={colItems(colMenu.p)} />
      )}
    </section>
  )
}
