// Cell editors. Inline kinds (title, number, url, email, phone) use <InlineInput>; the rest open a panel. Every edit is a
// `row.patch` command: the value is only shown as saved once the batch is durable, a failed save keeps the draft and says why.
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Cell, Definition, Id, RichRun } from '../model/types.ts'
import { civilOf } from '../dates.ts'
import { cfgOf, optionsOf, OPTION_COLORS, statusConfig, type SelectOption } from '../props/config.ts'
import { cellToText, defaultCell, parseCellText } from '../props/registry.ts'
import { matchKey } from '../text.ts'
import type { Row } from '../state.ts'
import type { DatabaseService } from '../service.ts'
import { putFile, urlFor } from '../../attachments'
import { Button, Field, FormField, Icon, IconButton, Notice, Panel, Popover } from '../../design-system'
import { t } from '../../i18n'
import { Chip, ErrorLine, Hint, errorText, plainTitle } from './common'
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
    if (r.ok) {
      setError(null)
      return true
    }
    setError(errorText(r.code, r.message))
    return false
  }
  return { save, error, pending, setError }
}

// ───── inline input (text-like, number, title) ─────

export function InlineInput({
  initial,
  kind,
  onCommit,
  onCancel,
  onNavigate,
  error,
  onDraftChange,
  placeholder,
}: {
  initial: string
  kind: 'text' | 'number' | 'url' | 'email' | 'phone' | 'title'
  onCommit: (text: string) => Promise<boolean> | boolean
  onCancel: () => void
  onNavigate?: (dir: 'next' | 'prev' | 'down' | 'up') => void
  error?: string | null
  onDraftChange?: () => void
  placeholder?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const [errorPos, setErrorPos] = useState<{ top: number; left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!error) return
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.min(320, window.innerWidth - 24)
      setErrorPos({ top: r.bottom + 100 <= window.innerHeight ? r.bottom + 6 : Math.max(12, r.top - 94), left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), width })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [error])
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
    <div className="dv-inline">
      <input
        ref={ref}
        className="dv-inline-input"
        value={v}
        dir={kind === 'number' || kind === 'url' || kind === 'email' || kind === 'phone' ? 'ltr' : 'auto'}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setV(e.target.value)
          onDraftChange?.()
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.key === 'Process') return // never act on Enter/Tab while a Persian IME composition is open
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            void commit(e.shiftKey ? undefined : 'down')
          } else if (e.key === 'Tab') {
            e.preventDefault()
            void commit(e.shiftKey ? 'prev' : 'next')
          }
        }}
        onBlur={() => void commit()}
      />
      {error &&
        errorPos &&
        createPortal(
          <Notice id={errorId} className="dv-cell-error" tone="bad" compact style={{ position: 'fixed', ...errorPos }}>{error}</Notice>,
          document.body,
        )}
    </div>
  )
}

export interface PopProps {
  svc: DatabaseService
  row: Row
  def: Definition
  anchor: DOMRect
  onClose: () => void
}

/** A search box at the top of a picker: Enter takes the first match, Escape closes. */
function PickerSearch({ value, onChange, placeholder, onEnter, onEscape }: { value: string; onChange: (v: string) => void; placeholder: string; onEnter?: () => void; onEscape: () => void }) {
  return (
    <Field
      autoFocus
      className="dv-picker-search"
      placeholder={placeholder}
      aria-label={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter' && onEnter) (e.preventDefault(), onEnter())
        if (e.key === 'Escape') onEscape()
      }}
    />
  )
}

/** One choice in a picker: a check where it is chosen, the label, and nothing else. */
function Choice({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button type="button" role="option" aria-selected={on} aria-label={label} className="ds-menu-item dv-choice" onClick={onClick}>
      <span className="dv-choice-check">{on && <Icon name="check" size={15} />}</span>
      <span className="ds-menu-label">{children}</span>
    </button>
  )
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
  const toggle = (id: Id) => (multi ? (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]) : [id])
  const set = async (ids: Id[]) => {
    const c: Cell = multi ? { kind: 'multi_select', optionIds: ids } : def.kind === 'status' ? { kind: 'status', optionId: ids[0] } : { kind: 'select', optionId: ids[0] ?? null }
    if ((await save(c)) && !multi) onClose()
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
  const option = (o: SelectOption) => (
    <Choice key={o.id} on={selected.includes(o.id)} onClick={() => void set(toggle(o.id))}>
      <Chip color={o.color}>{o.name}</Chip>
    </Choice>
  )
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Panel size="sm" className="dv-picker">
        <PickerSearch
          value={q}
          onChange={setQ}
          placeholder={canSchema && def.kind !== 'status' ? t('Search or create…') : t('Search…')}
          onEscape={onClose}
          onEnter={() => {
            if (shown[0] && (exact || !canSchema || !q.trim())) void set(toggle(shown[0].id))
            else if (q.trim() && canSchema && def.kind !== 'status') void create(q.trim())
          }}
        />
        <div className="dv-choices" role="listbox" aria-multiselectable={multi} aria-label={def.name}>
          {def.kind === 'status'
            ? groups.map((g) => {
                const items = shown.filter((o) => (o as SelectOption & { statusGroupId?: Id }).statusGroupId === g.id)
                return items.length ? (
                  <div key={g.id} role="group" aria-label={g.label}>
                    <div className="ds-menu-head">{g.label}</div>
                    {items.map(option)}
                  </div>
                ) : null
              })
            : shown.map(option)}
          {q.trim() && !exact && canSchema && def.kind !== 'status' && (
            <button type="button" className="ds-menu-item dv-choice" onClick={() => void create(q.trim())}>
              <span className="dv-choice-check">
                <Icon name="plus" size={15} />
              </span>
              <span className="ds-menu-label">
                {t('Create')} <Chip>{q.trim()}</Chip>
              </span>
            </button>
          )}
          {shown.length === 0 && !q.trim() && <Hint>{t('No options yet')}</Hint>}
        </div>
        {!multi && def.kind === 'select' && selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void set([])}>
            {t('Clear')}
          </Button>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
  )
}

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
      if (!(await save({ kind: 'date', value: draftRef.current }))) {
        closing.current = false
        return
      }
    }
    onClose()
  }
  const cfg = cfgOf.date(def)
  const zone = cfg.defaultZone ?? svc.zone
  return (
    <Popover anchor={anchor} onClose={() => void finish()}>
      <Panel size="sm">
        <DatePicker value={draft} config={cfg} zone={zone} weekStart={svc.weekStart} todayCivil={civilOf(svc.now(), zone)} onChange={setDraft} onClose={() => void finish()} />
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
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
    <Popover anchor={anchor} onClose={onClose}>
      <Panel size="sm" className="dv-picker">
        <div className="dv-choices" role="listbox" aria-label={def.name}>
          {people.map((p) => {
            const on = sel.includes(p.id)
            return (
              <Choice
                key={p.id}
                on={on}
                onClick={async () => {
                  const next = on ? sel.filter((x) => x !== p.id) : multiple ? [...sel, p.id] : [p.id]
                  if ((await save({ kind: 'people', principalIds: next })) && !multiple) onClose()
                }}
              >
                <span dir="auto">{p.displayName}</span>
                {p.isLocalOwner && <small className="ds-muted"> · {t('you')}</small>}
              </Choice>
            )
          })}
          {people.length === 0 && <Hint>{t('No people are available yet')}</Hint>}
        </div>
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
  )
}

// ───── files ─────

function FileThumb({ id }: { id: Id }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void urlFor('att:' + id).then((u) => live && setSrc(u))
    return () => void (live = false)
  }, [id])
  return src ? (
    <img className="dv-file-thumb" alt="" src={src} />
  ) : (
    <span className="dv-file-thumb">
      <Icon name="file" size={16} />
    </span>
  )
}

function FilesEditor({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cell = row.ext.cells[def.id]?.value
  const ids = cell?.kind === 'files' ? cell.attachmentIds : []
  const names = useFileNames(ids)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cfg = cfgOf.files(def)
  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setMsg(null)
    try {
      const next = [...ids]
      for (const f of Array.from(files)) {
        if (f.size > cfg.maxBytes) {
          setMsg(t('{n} is larger than the limit.', { n: f.name }))
          continue
        }
        if (cfg.allowedTypes.length && !cfg.allowedTypes.some((a) => (a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a))) {
          setMsg(t('{n}: this file type is not allowed.', { n: f.name }))
          continue
        }
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
    <Popover anchor={anchor} onClose={onClose}>
      <Panel
        title={def.name}
        footer={
          <>
            <input ref={input} type="file" multiple hidden disabled={busy} onChange={(e) => void add(e.target.files)} />
            <Button size="sm" icon={<Icon name="upload" size={15} />} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? t('Uploading…') : t('Upload files')}
            </Button>
          </>
        }
      >
        {ids.length > 0 ? (
          <div className="dv-files">
            {ids.map((id, i) => (
              <div className="dv-file" key={id}>
                <FileThumb id={id} />
                <span className="dv-file-name" dir="auto" title={names.get(id) || undefined}>
                  {names.get(id) || t('File')}
                </span>
                <IconButton label={t('Move up')} onClick={() => move(i, -1)} disabled={i === 0}>
                  <Icon name="arrow-up" size={15} />
                </IconButton>
                <IconButton label={t('Remove')} onClick={() => void save({ kind: 'files', attachmentIds: ids.filter((x) => x !== id) })}>
                  <Icon name="x" size={15} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <Hint>{t('No files yet')}</Hint>
        )}
        {msg && <ErrorLine>{msg}</ErrorLine>}
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
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
    <Popover anchor={anchor} onClose={onClose}>
      <Panel className="dv-picker">
        {current.length > 0 && (
          <div className="dv-chips">
            {current.map((c) => (
              <Chip key={c.edgeId} muted={c.state !== 'live'} onRemove={() => void run('relation.remove', c.pageId)} title={c.state === 'trashed' ? t('This item is in the trash') : undefined}>
                {c.state === 'live' ? plainTitle(rs.title(c.pageId)) : c.state === 'trashed' ? t('(deleted) {n}', { n: svc.state.pages.get(c.pageId)?.title ?? '' }) : '…'}
              </Chip>
            ))}
          </div>
        )}
        <PickerSearch value={q} onChange={setQ} placeholder={t('Search items…')} onEscape={onClose} onEnter={() => results[0] && void run(linked.has(results[0]) ? 'relation.remove' : 'relation.add', results[0], single)} />
        <div className="dv-choices" role="listbox" aria-label={def.name}>
          {results.map((id) => {
            const on = linked.has(id)
            return (
              <Choice key={id} on={on} onClick={() => void run(on ? 'relation.remove' : 'relation.add', id, single)}>
                <span dir="auto">{plainTitle(svc.state.pages.get(id)?.title)}</span>
              </Choice>
            )
          })}
          {results.length === 0 && <Hint>{t('Nothing found')}</Hint>}
        </div>
        {single && <Hint>{t('This relation links one item; choosing another replaces it.')}</Hint>}
        {err && <ErrorLine>{err}</ErrorLine>}
      </Panel>
    </Popover>
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
    <Popover anchor={anchor} onClose={() => void commit()}>
      <Panel
        title={def.name}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void commit()}>
              {t('Save')}
            </Button>
          </>
        }
      >
        <FormField label={t('Name')}>
          <Field value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label={t('Address')}>
          <Field value={address} onChange={(e) => setAddress(e.target.value)} />
        </FormField>
        <div className="dv-pair">
          <FormField label={t('Latitude')}>
            <Field ltr inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          </FormField>
          <FormField label={t('Longitude')}>
            <Field ltr inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
          </FormField>
        </div>
        <Hint>{t('Coordinates you type are saved on this device and work offline. Looking up an address needs a map provider (Settings → Database).')}</Hint>
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
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
    <Popover anchor={anchor} onClose={onClose}>
      <Panel
        size="sm"
        title={def.name}
        footer={
          <>
            {v.state === 'verified' && (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (await save({ kind: 'verification', value: { state: 'unverified', verifierId: null, verifiedAt: null, expiresAt: null } })) onClose()
                }}
              >
                {t('Remove verification')}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => void verify()}>
              {v.state === 'verified' ? t('Verify again') : t('Verify')}
            </Button>
          </>
        }
      >
        <p className="dv-text">{v.state === 'verified' ? t('Verified by {n}', { n: svc.state.get('principal', v.verifierId ?? '')?.displayName ?? '' }) : t('Not verified')}</p>
        {v.expiresAt && <Hint>{t('Expires {d}', { d: new Date(v.expiresAt).toLocaleDateString() })}</Hint>}
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
  )
}

// ───── rich text ─────

function TextEditorPop({ svc, row, def, anchor, onClose }: PopProps) {
  const { save, error } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const runs: RichRun[] = cur?.kind === 'text' ? cur.runs : []
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Panel size="lg">
        <RichTextEditor
          runs={runs}
          pages={() =>
            svc.state.pages
              .all()
              .filter((p) => p.deletedAt === null && p.kind !== 'folder')
              .map((p) => ({ id: p.id, title: p.title }))
          }
          onCommit={async (next) => {
            if (JSON.stringify(next) === JSON.stringify(runs)) return onClose()
            if (await save({ kind: 'text', runs: next })) onClose()
          }}
          onCancel={onClose}
        />
        {error && <ErrorLine>{error}</ErrorLine>}
      </Panel>
    </Popover>
  )
}

/** The panel editor for kinds that have one; null for kinds edited inline or read-only. */
export function PopoverEditor(p: PopProps) {
  switch (p.def.kind) {
    case 'select':
    case 'multi_select':
    case 'status':
      return <SelectEditor {...p} />
    case 'date':
      return <DateEditor {...p} />
    case 'people':
      return <PeopleEditor {...p} />
    case 'files':
      return <FilesEditor {...p} />
    case 'relation':
      return <RelationEditor {...p} />
    case 'place':
      return <PlaceEditor {...p} />
    case 'verification':
      return <VerificationEditor {...p} />
    case 'text':
      return <TextEditorPop {...p} />
    default:
      return null
  }
}

export const isInlineKind = (k: Definition['kind']) => k === 'number' || k === 'url' || k === 'email' || k === 'phone' || k === 'title' || k === 'connected'
export const isPopoverKind = (k: Definition['kind']) => ['select', 'multi_select', 'status', 'date', 'people', 'files', 'relation', 'place', 'verification', 'text'].includes(k)

/** Inline editor for number / url / email / phone / title: validates through the same parser as paste and import. */
export function InlineCellEditor({
  svc,
  row,
  def,
  onClose,
  onNavigate,
  initial,
}: {
  svc: DatabaseService
  row: Row
  def: Definition
  onClose: () => void
  onNavigate?: (d: 'next' | 'prev' | 'down' | 'up') => void
  initial?: string
}) {
  const { save, error, setError } = useSaver(svc, row, def)
  const cur = row.ext.cells[def.id]?.value
  const start = initial ?? (def.kind === 'title' ? row.page.title : cur ? cellToText(def, cur) : '')
  return (
    <InlineInput
      initial={start}
      kind={def.kind as 'number'}
      error={error}
      onDraftChange={() => setError(null)}
      onCancel={onClose}
      onNavigate={onNavigate}
      onCommit={async (text) => {
        if (text === start) {
          onClose()
          return true
        }
        if (def.kind === 'title') {
          const r = await svc.tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, title: text } }], {
            expected: [{ recordKind: 'page', id: row.page.id, revision: row.page.recordMeta?.revision ?? 0 }],
          })
          if (!r.ok) {
            setError(errorText(r.code, r.message))
            return false
          }
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
