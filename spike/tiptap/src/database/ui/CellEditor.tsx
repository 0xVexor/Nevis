// Cell editors. Inline kinds (text-like, number) use <InlineInput>; the rest open a popover. Every edit is a `row.patch` command:
// the value is only shown as saved once the batch is durable, a failed save keeps the draft and says why.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Cell, Definition, Id, RichRun } from '../model/types.ts'
import { civilOf } from '../dates.ts'
import { cfgOf, optionsOf, OPTION_COLORS, statusConfig, type SelectOption } from '../props/config.ts'
import { cellToText, defaultCell, parseCellText } from '../props/registry.ts'
import { textToRuns, runsToText, matchKey } from '../text.ts'
import type { Row } from '../state.ts'
import type { DatabaseService } from '../service.ts'
import { putFile, urlFor } from '../../attachments'
import { Popover, MenuLabel } from '../../ui'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { Chip, COLOR_CLASS, errorText, plainTitle } from './common'
import { useFileNames } from './CellView'
import { DatePicker } from './DatePicker'
import { RichTextEditor } from './RichText'

export type Saver = (cell: Cell | null) => Promise<boolean>

/** Returns a save function for one cell; `error` holds the message of the last failed save. */
export function useSaver(svc: DatabaseService, row: Row, def: Definition) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const save: Saver = async (cell) => {
    setPending(true)
    const r = await svc.tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, cellChanges: { [def.id]: cell as never } } }], {
      expected: [{ recordKind: 'page', id: row.page.id, revision: row.page.recordMeta?.revision ?? 0 }],
    })
    setPending(false)
    if (r.ok) { setError(null); return true }
    setError(errorText(r.code, r.message))
    return false
  }
  return { save, error, pending, setError }
}

// ───── inline input (text-like, number, title) ─────

export function InlineInput({ initial, kind, onCommit, onCancel, onNavigate, error, placeholder, ltr }: {
  initial: string
  kind: 'text' | 'number' | 'url' | 'email' | 'phone' | 'title'
  onCommit: (text: string) => Promise<boolean> | boolean
  onCancel: () => void
  onNavigate?: (dir: 'next' | 'prev' | 'down' | 'up') => void
  error?: string | null
  placeholder?: string
  ltr?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [v, setV] = useState(initial)
  const busy = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = async (nav?: 'next' | 'prev' | 'down') => {
    if (busy.current) return
    busy.current = true
    const ok = await onCommit(v)
    busy.current = false
    if (ok && nav) onNavigate?.(nav)
  }
  return (
    <div className="db-inline">
      <input
        ref={ref}
        className={'db-input' + (error ? ' err' : '')}
        value={v}
        dir={ltr || kind === 'number' || kind === 'url' || kind === 'email' || kind === 'phone' ? 'ltr' : 'auto'}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        placeholder={placeholder}
        aria-invalid={!!error}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.key === 'Process') return // never act on Enter/Tab while a Persian IME composition is open
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
          else if (e.key === 'Enter') { e.preventDefault(); void commit(e.shiftKey ? undefined : 'down') }
          else if (e.key === 'Tab') { e.preventDefault(); void commit(e.shiftKey ? 'prev' : 'next') }
        }}
        onBlur={() => void commit()}
      />
      {error && <div className="db-err" role="alert">{error}</div>}
    </div>
  )
}

// ───── popover shell ─────

function Shell({ anchor, onClose, children, wide }: { anchor: DOMRect; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className={'db-pop' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </Popover>
  )
}

export interface PopProps {
  svc: DatabaseService
  row: Row
  def: Definition
  anchor: DOMRect
  onClose: () => void
}

// ───── select / multi-select / status ─────

function SelectEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const multi = def.kind === 'multi_select'
  const opts = optionsOf(def)
  const cell = row.ext.cells[def.id]?.value ?? defaultCell(def)
  const selected: Id[] = cell?.kind === 'multi_select' ? cell.optionIds : cell && (cell.kind === 'select' || cell.kind === 'status') && cell.optionId ? [cell.optionId] : []
  const [q, setQ] = useState('')
  const canSchema = svc.access().sourceCaps(svc.principalId, def.sourceId).has('edit_schema')
  const shown = opts.filter((o) => matchKey(o.name).includes(matchKey(q)))
  const exact = opts.some((o) => matchKey(o.name).trim() === matchKey(q).trim())
  const groups = def.kind === 'status' ? statusConfig(def.config).groups : []
  const set = async (ids: Id[]) => {
    const c: Cell = multi ? { kind: 'multi_select', optionIds: ids } : def.kind === 'status' ? { kind: 'status', optionId: ids[0] } : { kind: 'select', optionId: ids[0] ?? null }
    if (await save(c) && !multi) onClose()
  }
  const create = async (name: string) => {
    const id = crypto.randomUUID()
    const grp = def.kind === 'status' ? groups[0]?.id : undefined
    const next = multi ? [...selected, id] : [id]
    const c: Cell = multi ? { kind: 'multi_select', optionIds: next } : def.kind === 'status' ? { kind: 'status', optionId: id } : { kind: 'select', optionId: id }
    const r = await svc.tryExec([
      { type: 'option.upsert', payload: { propertyId: def.id, optionId: id, name, color: OPTION_COLORS[Math.floor(Math.random() * 9) + 1], ...(grp ? { statusGroupId: grp } : {}) } },
      { type: 'row.patch', payload: { pageId: row.page.id, cellChanges: { [def.id]: c } } },
    ])
    if (r.ok && !multi) onClose()
    setQ('')
  }
  return (
    <Shell anchor={anchor} onClose={onClose}>
      <input className="db-input" autoFocus placeholder={t('Search or create…')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') { e.preventDefault(); if (shown[0] && (exact || !canSchema || !q.trim())) void set(multi ? (selected.includes(shown[0].id) ? selected.filter((x) => x !== shown[0].id) : [...selected, shown[0].id]) : [shown[0].id]); else if (q.trim() && canSchema) void create(q.trim()) }
        if (e.key === 'Escape') onClose()
      }} />
      <div className="db-opts" role="listbox" aria-multiselectable={multi}>
        {!multi && def.kind === 'select' && selected.length > 0 && <button type="button" className="menu-item" onClick={() => void set([])}><span className="menu-tx dim">{t('Clear')}</span></button>}
        {def.kind === 'status' ? groups.map((g) => {
          const items = shown.filter((o) => (o as SelectOption & { statusGroupId?: Id }).statusGroupId === g.id)
          return items.length ? <div key={g.id}><MenuLabel>{g.label}</MenuLabel>{items.map((o) => <OptionRow key={o.id} o={o} on={selected.includes(o.id)} onClick={() => void set([o.id])} />)}</div> : null
        }) : shown.map((o) => <OptionRow key={o.id} o={o} on={selected.includes(o.id)} onClick={() => void set(multi ? (selected.includes(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id]) : [o.id])} />)}
        {q.trim() && !exact && canSchema && def.kind !== 'status' && (
          <button type="button" className="menu-item" onClick={() => void create(q.trim())}>
            <span className="menu-ic"><Ic.Plus size={13} /></span>
            <span className="menu-tx">{t('Create')} <Chip>{q.trim()}</Chip></span>
          </button>
        )}
        {shown.length === 0 && !q.trim() && <div className="db-empty-hint">{t('No options yet')}</div>}
      </div>
      {error && <div className="db-err" role="alert">{error}</div>}
    </Shell>
  )
}
const OptionRow = ({ o, on, onClick }: { o: SelectOption; on: boolean; onClick: () => void }) => (
  <button type="button" role="option" aria-selected={on} className={'menu-item' + (on ? ' on' : '')} onClick={onClick}>
    <span className="menu-ic">{on && <Ic.Check size={13} />}</span>
    <span className="menu-tx"><Chip color={o.color}>{o.name}</Chip></span>
  </button>
)

// ───── date ─────

function DateEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cell = row.ext.cells[def.id]?.value
  const [draft, setDraft] = useState(cell?.kind === 'date' ? cell.value : null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const original = useRef(cell?.kind === 'date' ? cell.value : null)
  const closing = useRef(false)
  const finish = async () => {
    if (closing.current) return
    closing.current = true
    if (JSON.stringify(draftRef.current) !== JSON.stringify(original.current)) {
      if (!(await save({ kind: 'date', value: draftRef.current }))) { closing.current = false; return }
    }
    onClose()
  }
  const cfg = cfgOf.date(def)
  const zone = cfg.defaultZone ?? svc.zone
  return (
    <Popover anchor={anchor} onClose={() => void finish()}>
      <div className="db-pop" onClick={(e) => e.stopPropagation()}>
        <DatePicker value={draft} config={cfg} zone={zone} weekStart={svc.weekStart} todayCivil={civilOf(svc.now(), zone)} onChange={setDraft} onClose={() => void finish()} />
        {error && <div className="db-err" role="alert">{error}</div>}
      </div>
    </Popover>
  )
}

// ───── people ─────

function PeopleEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cell = row.ext.cells[def.id]?.value
  const sel = cell?.kind === 'people' ? cell.principalIds : []
  const multiple = cfgOf.people(def).multiple
  const people = svc.state.live('principal').filter((p) => p.type === 'user')
  return (
    <Shell anchor={anchor} onClose={onClose}>
      <div className="db-opts" role="listbox">
        {people.map((p) => {
          const on = sel.includes(p.id)
          return (
            <button key={p.id} type="button" role="option" aria-selected={on} className={'menu-item' + (on ? ' on' : '')} onClick={async () => {
              const next = on ? sel.filter((x) => x !== p.id) : multiple ? [...sel, p.id] : [p.id]
              if (await save({ kind: 'people', principalIds: next }) && !multiple) onClose()
            }}>
              <span className="menu-ic">{on && <Ic.Check size={13} />}</span>
              <span className="menu-tx">{p.displayName}{p.isLocalOwner && <small> · {t('you')}</small>}</span>
            </button>
          )
        })}
        {people.length === 0 && <div className="db-empty-hint">{t('No people are available yet')}</div>}
      </div>
      {error && <div className="db-err" role="alert">{error}</div>}
    </Shell>
  )
}

// ───── files ─────

function FileThumb({ id }: { id: Id }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => { let live = true; void urlFor('att:' + id).then((u) => live && setSrc(u)); return () => void (live = false) }, [id])
  return src ? <img className="db-thumb" alt="" src={src} /> : <span className="db-thumb ph"><Ic.Page size={14} /></span>
}

function FilesEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cell = row.ext.cells[def.id]?.value
  const ids = cell?.kind === 'files' ? cell.attachmentIds : []
  const names = useFileNames(ids)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const cfg = cfgOf.files(def)
  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setMsg(null)
    try {
      const next = [...ids]
      for (const f of Array.from(files)) {
        if (f.size > cfg.maxBytes) { setMsg(t('{n} is larger than the limit.', { n: f.name })); continue }
        if (cfg.allowedTypes.length && !cfg.allowedTypes.some((a) => (a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a))) { setMsg(t('{n}: this file type is not allowed.', { n: f.name })); continue }
        if (f.size > 100 * 1024 * 1024) setMsg(t('This is a large file ({n} MB).', { n: Math.round(f.size / 1048576) }))
        const id = await putFile(f)
        if (!next.includes(id)) next.push(id)
      }
      await save({ kind: 'files', attachmentIds: next })
    } catch (e) {
      setMsg(String(e))
    }
    setBusy(false)
  }
  const move = (i: number, d: number) => {
    const next = [...ids]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    void save({ kind: 'files', attachmentIds: next })
  }
  return (
    <Shell anchor={anchor} onClose={onClose} wide>
      <div className="db-files">
        {ids.map((id, i) => (
          <div className="db-file-row" key={id}>
            <FileThumb id={id} />
            <span className="db-file-name" dir="auto">{names.get(id) || t('File')}</span>
            <button type="button" className="icon-btn" aria-label={t('Move up')} onClick={() => move(i, -1)} disabled={i === 0}><Ic.Up size={13} /></button>
            <button type="button" className="icon-btn" aria-label={t('Remove')} onClick={() => void save({ kind: 'files', attachmentIds: ids.filter((x) => x !== id) })}><Ic.Close size={13} /></button>
          </div>
        ))}
        {ids.length === 0 && <div className="db-empty-hint">{t('No files yet')}</div>}
        <label className="db-upload">
          <input type="file" multiple hidden disabled={busy} onChange={(e) => void add(e.target.files)} />
          <Ic.Upload size={14} /> {busy ? t('Uploading…') : t('Upload files')}
        </label>
        {msg && <div className="db-err" role="alert">{msg}</div>}
        {error && <div className="db-err" role="alert">{error}</div>}
      </div>
    </Shell>
  )
}

// ───── relation ─────

function RelationEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const rel = svc.state.relationOf(def.id)
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const rs = svc.resolver()
  const forward = rel?.propertyId === def.id
  const targetSource = rel ? (forward ? rel.targetSourceId : rel.sourceId) : null
  const current = rel ? rs.relationTargets(row, def) : []
  const linked = new Set(current.filter((c) => c.state !== 'pending').map((c) => c.pageId))
  const single = rel ? (forward ? rel.cardinality === 'one' : rel.inverseCardinality === 'one') : false
  const results = useMemo(() => {
    if (!targetSource) return []
    try {
      return svc.query(targetSource, { search: q, limit: 30 }).pageIds
    } catch {
      return []
    }
  }, [svc, targetSource, q, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (type: string, other: Id, replace = false) => {
    const r = await svc.tryExec([{ type, payload: { propertyId: def.id, fromPageId: row.page.id, toPageId: other, ...(replace ? { replace: true } : {}) } }])
    setErr(r.ok ? null : errorText(r.code, r.message))
    if (r.ok && single && type === 'relation.add') onClose()
  }
  return (
    <Shell anchor={anchor} onClose={onClose} wide>
      {current.length > 0 && (
        <div className="db-rel-cur">
          {current.map((c) => (
            <Chip key={c.edgeId} muted={c.state !== 'live'} onRemove={() => void run('relation.remove', c.pageId)} title={c.state === 'trashed' ? t('This item is in the trash') : undefined}>
              {c.state === 'live' ? plainTitle(rs.title(c.pageId)) : c.state === 'trashed' ? t('(deleted) {n}', { n: svc.state.pages.get(c.pageId)?.title ?? '' }) : '…'}
            </Chip>
          ))}
        </div>
      )}
      <input className="db-input" autoFocus placeholder={t('Search items…')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
      <div className="db-opts" role="listbox">
        {results.map((id) => {
          const on = linked.has(id)
          return (
            <button key={id} type="button" role="option" aria-selected={on} className={'menu-item' + (on ? ' on' : '')} onClick={() => void run(on ? 'relation.remove' : 'relation.add', id, single)}>
              <span className="menu-ic">{on && <Ic.Check size={13} />}</span>
              <span className="menu-tx" dir="auto">{plainTitle(svc.state.pages.get(id)?.title)}</span>
            </button>
          )
        })}
        {results.length === 0 && <div className="db-empty-hint">{t('Nothing found')}</div>}
      </div>
      {single && <div className="db-date-hint">{t('This relation links one item; choosing another replaces it.')}</div>}
      {err && <div className="db-err" role="alert">{err}</div>}
    </Shell>
  )
}

// ───── place ─────

function PlaceEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const v = cur?.kind === 'place' ? cur.value : null
  const [name, setName] = useState(v?.name ?? '')
  const [address, setAddress] = useState(v?.address ?? '')
  const [lat, setLat] = useState(v?.lat === null || v?.lat === undefined ? '' : String(v.lat))
  const [lon, setLon] = useState(v?.lon === null || v?.lon === undefined ? '' : String(v.lon))
  const commit = async () => {
    const empty = !name.trim() && !address.trim() && !lat.trim() && !lon.trim()
    const la = lat.trim() ? Number(lat) : null
    const lo = lon.trim() ? Number(lon) : null
    if (await save(empty ? null : { kind: 'place', value: { lat: la, lon: lo, name, address } })) onClose()
  }
  return (
    <Shell anchor={anchor} onClose={() => void commit()} wide>
      <div className="db-form">
        <label>{t('Name')}<input className="db-input" value={name} onChange={(e) => setName(e.target.value)} dir="auto" /></label>
        <label>{t('Address')}<input className="db-input" value={address} onChange={(e) => setAddress(e.target.value)} dir="auto" /></label>
        <div className="db-row2">
          <label>{t('Latitude')}<input className="db-input" dir="ltr" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} /></label>
          <label>{t('Longitude')}<input className="db-input" dir="ltr" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} /></label>
        </div>
        <div className="db-date-hint">{t('Coordinates you type are saved on this device and work offline. Looking up an address needs a map provider (Settings → Database).')}</div>
        {error && <div className="db-err" role="alert">{error}</div>}
        <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary" onClick={() => void commit()}>{t('Save')}</button></div>
      </div>
    </Shell>
  )
}

// ───── verification ─────

function VerificationEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const v = cur?.kind === 'verification' ? cur.value : { state: 'unverified' as const, verifierId: null, verifiedAt: null, expiresAt: null }
  const policy = cfgOf.verification(def).expiryPolicy
  const days = policy === 'never' ? null : Number(policy.replace('d', ''))
  const verify = async () => {
    const now = svc.now()
    if (await save({ kind: 'verification', value: { state: 'verified', verifierId: svc.principalId, verifiedAt: now, expiresAt: days ? now + days * 86400000 : null } })) onClose()
  }
  return (
    <Shell anchor={anchor} onClose={onClose}>
      <div className="db-form">
        <div>{v.state === 'verified' ? t('Verified by {n}', { n: svc.state.get('principal', v.verifierId ?? '')?.displayName ?? '' }) : t('Not verified')}</div>
        {v.expiresAt && <div className="db-date-hint">{t('Expires {d}', { d: new Date(v.expiresAt).toLocaleDateString() })}</div>}
        <div className="db-date-foot">
          {v.state === 'verified' && <button type="button" className="danger" onClick={async () => { if (await save({ kind: 'verification', value: { state: 'unverified', verifierId: null, verifiedAt: null, expiresAt: null } })) onClose() }}>{t('Remove verification')}</button>}
          <button type="button" className="primary" onClick={() => void verify()}>{v.state === 'verified' ? t('Verify again') : t('Verify')}</button>
        </div>
        {error && <div className="db-err" role="alert">{error}</div>}
      </div>
    </Shell>
  )
}

// ───── rich text (popover) ─────

function TextEditorPop({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const runs: RichRun[] = cur?.kind === 'text' ? cur.runs : []
  return (
    <Shell anchor={anchor} onClose={onClose} wide>
      <RichTextEditor
        runs={runs}
        pages={() => svc.state.pages.all().filter((p) => p.deletedAt === null && p.kind !== 'folder').map((p) => ({ id: p.id, title: p.title }))}
        onCommit={async (next) => {
          if (JSON.stringify(next) === JSON.stringify(runs)) return onClose()
          if (await save({ kind: 'text', runs: next })) onClose()
        }}
        onCancel={onClose}
      />
      {error && <div className="db-err" role="alert">{error}</div>}
    </Shell>
  )
}

/** The popover editor for kinds that have one; null for kinds edited inline or read-only. */
export function PopoverEditor(p: PopProps) {
  switch (p.def.kind) {
    case 'select': case 'multi_select': case 'status': return <SelectEditor {...p} />
    case 'date': return <DateEditor {...p} />
    case 'people': return <PeopleEditor {...p} />
    case 'files': return <FilesEditor {...p} />
    case 'relation': return <RelationEditor {...p} />
    case 'place': return <PlaceEditor {...p} />
    case 'verification': return <VerificationEditor {...p} />
    case 'text': return <TextEditorPop {...p} />
    default: return null
  }
}

export const isInlineKind = (k: Definition['kind']) => k === 'number' || k === 'url' || k === 'email' || k === 'phone' || k === 'title' || k === 'connected'
export const isPopoverKind = (k: Definition['kind']) => ['select', 'multi_select', 'status', 'date', 'people', 'files', 'relation', 'place', 'verification', 'text'].includes(k)

/** Inline editor for number / url / email / phone / title: validates through the same parser as paste and import. */
export function InlineCellEditor({ svc, row, def, onClose, onNavigate, initial }: { svc: DatabaseService; row: Row; def: Definition; onClose: () => void; onNavigate?: (d: 'next' | 'prev' | 'down' | 'up') => void; initial?: string }) {
  const { save, error, setError } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const start = initial ?? (def.kind === 'title' ? row.page.title : cur ? cellToText(def, cur) : '')
  return (
    <InlineInput
      initial={start}
      kind={def.kind as 'number'}
      error={error}
      onCancel={onClose}
      onNavigate={onNavigate}
      onCommit={async (text) => {
        if (text === start) { onClose(); return true }
        if (def.kind === 'title') {
          const r = await svc.tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, title: text } }], { expected: [{ recordKind: 'page', id: row.page.id, revision: row.page.recordMeta?.revision ?? 0 }] })
          if (!r.ok) { setError(errorText(r.code, r.message)); return false }
          onClose()
          return true
        }
        let cell: Cell
        try {
          cell = text.trim() === '' ? (def.kind === 'number' ? { kind: 'number', value: null } : ({ kind: def.kind, value: null } as Cell)) : parseCellText(def, text, { decimalSeparator: '.' })
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          return false // invalid input keeps the previous value; the draft stays open with the message
        }
        const ok = await save(cell)
        if (ok) onClose()
        return ok
      }}
    />
  )
}

export { textToRuns, runsToText, COLOR_CLASS }
