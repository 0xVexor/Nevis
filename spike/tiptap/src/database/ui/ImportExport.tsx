// Import / export / backup of one database: CSV import wizard (explicit mapping, nothing guessed), CSV / Markdown export of the
// current view, native bundle backup and validated restore, schema or full duplicate.
import { useMemo, useRef, useState } from 'react'
import type { Container, Id, Json, View } from '../model/types.ts'
import { buildBundle, validateBundle, type Bundle } from '../backup2.ts'
import { exportCsv, exportMarkdown, parseCsv, planImport, worldOf, type ColumnMap, type ImportOptions } from '../csv.ts'
import { DESCRIPTORS } from '../props/registry.ts'
import type { DatabaseService } from '../service.ts'
import { download } from '../../backup'
import { Popover, MenuItem, MenuLabel, MenuSep, Select } from '../../ui'
import { confirmDialog, promptDialog } from '../../dialog'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { errorText } from './common'
import { Field, Seg, Switch } from './forms'

const slug = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'database'

export function ImportExportMenu({ svc, container, source, view, anchor, onClose, notify, canSchema }: { svc: DatabaseService; container: Container; source: Id; view: View; anchor: DOMRect; onClose: () => void; notify: (m: string) => void; canSchema: boolean }) {
  const [wizard, setWizard] = useState<{ data: string[][]; name: string } | null>(null)
  const [restore, setRestore] = useState<Bundle | null>(null)
  const csvInput = useRef<HTMLInputElement>(null)
  const bundleInput = useRef<HTMLInputElement>(null)
  const name = slug(container.title)
  const personal = (() => { try { return JSON.parse(localStorage.getItem('db.personal.' + view.id) ?? 'null') as { filter?: never; sorts?: never } | null } catch { return null } })()
  const query = { filter: personal?.filter !== undefined ? personal.filter : view.filter, sorts: personal?.sorts ?? view.sorts }
  const exportAs = (kind: 'csv' | 'md', safe: boolean) => {
    const o = { sourceId: source, principalId: svc.principalId, now: svc.nowIso(), zone: svc.zone, query, safe, propertyIds: (view.configuration as { visibleProperties?: Id[] }).visibleProperties }
    if (kind === 'csv') download(`${name}.csv`, new Blob([exportCsv(svc.state, o)], { type: 'text/csv;charset=utf-8' }))
    else download(`${name}.md`, new Blob([exportMarkdown(svc.state, o)], { type: 'text/markdown;charset=utf-8' }))
    onClose()
  }
  const exportBundle = () => {
    download(`${name}.noviq-database.json`, new Blob([JSON.stringify(buildBundle(svc.state))], { type: 'application/json' }))
    onClose()
  }
  const duplicate = async (withRows: boolean) => {
    onClose()
    const r = await svc.tryExec([{ type: 'database.duplicate', payload: { containerId: container.id, withRows } }])
    notify(r.ok ? t(withRows ? 'Duplicated with all items.' : 'Duplicated (structure only).') : errorText(r.code, r.message))
  }
  return (
    <>
      <Popover anchor={anchor} onClose={onClose} align="end">
        <div className="menu">
          <MenuLabel>{t('Import')}</MenuLabel>
          <MenuItem icon={<Ic.Upload size={14} />} label={t('Import CSV…')} onClick={() => csvInput.current?.click()} />
          <MenuLabel>{t('Export this view')}</MenuLabel>
          <MenuItem icon={<Ic.Download size={14} />} label={t('CSV (safe for spreadsheets)')} onClick={() => exportAs('csv', true)} />
          <MenuItem icon={<Ic.Download size={14} />} label={t('CSV (raw values)')} onClick={() => exportAs('csv', false)} />
          <MenuItem icon={<Ic.Markdown size={14} />} label={t('Markdown table')} onClick={() => exportAs('md', true)} />
          <MenuItem icon={<Ic.Print size={14} />} label={t('Print')} onClick={() => (onClose(), window.setTimeout(() => window.print(), 50))} />
          <MenuSep />
          <MenuLabel>{t('Backup')}</MenuLabel>
          <MenuItem icon={<Ic.Archive size={14} />} label={t('Export the whole database (restorable)')} onClick={exportBundle} />
          <MenuItem icon={<Ic.Reset size={14} />} label={t('Restore from a database backup…')} disabled={!canSchema} onClick={() => bundleInput.current?.click()} />
          <MenuSep />
          <MenuItem icon={<Ic.Copy size={14} />} label={t('Duplicate with all items')} disabled={!canSchema} onClick={() => void duplicate(true)} />
          <MenuItem icon={<Ic.Copy size={14} />} label={t('Duplicate structure only')} disabled={!canSchema} onClick={() => void duplicate(false)} />
        </div>
      </Popover>
      <input ref={csvInput} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        try { setWizard({ data: parseCsv(await f.text()), name: f.name }) } catch (err) { notify(String(err instanceof Error ? err.message : err)) }
      }} />
      <input ref={bundleInput} type="file" accept=".json,application/json" hidden onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        try {
          const b = JSON.parse(await f.text())
          const problems = validateBundle(b).filter((p) => p.severity === 'error')
          if (problems.length) return notify(t('This is not a valid database backup: {m}', { m: problems[0].detail }))
          setRestore(b)
        } catch { notify(t('Not a valid JSON file.')) }
      }} />
      {wizard && <CsvWizard svc={svc} source={source} data={wizard.data} fileName={wizard.name} onClose={() => (setWizard(null), onClose())} notify={notify} />}
      {restore && <RestoreDialog svc={svc} bundle={restore} onClose={() => (setRestore(null), onClose())} notify={notify} />}
    </>
  )
}

// ───── CSV wizard ─────

function CsvWizard({ svc, source, data, fileName, onClose, notify }: { svc: DatabaseService; source: Id; data: string[][]; fileName: string; onClose: () => void; notify: (m: string) => void }) {
  const props = svc.state.props(source).filter((p) => p.kind === 'title' || DESCRIPTORS[p.kind].writable || p.kind === 'relation')
  const cols = Math.max(0, ...data.map((r) => r.length))
  const [hasHeader, setHasHeader] = useState(true)
  const header = hasHeader ? data[0] ?? [] : []
  const guess = (i: number): ColumnMap['target'] => {
    const h = (header[i] ?? '').trim().toLowerCase()
    const hit = props.find((p) => p.name.trim().toLowerCase() === h)
    return hit ? hit.id : i === 0 && !header.length ? 'title' : 'skip'
  }
  const [map, setMap] = useState<ColumnMap['target'][]>(() => Array.from({ length: cols }, (_, i) => guess(i)))
  const [decimal, setDecimal] = useState('.')
  const [delim, setDelim] = useState('')
  const [createOptions, setCreateOptions] = useState(false)
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [upsert, setUpsert] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const session = useRef(crypto.randomUUID()) // retrying the same import never adds the rows twice
  const options: ImportOptions = useMemo(() => ({
    sourceId: source, sessionId: session.current, hasHeader, columns: map.map((target, column) => ({ column, target })), decimalSeparator: decimal, listDelimiter: delim || undefined, zone: svc.zone,
    createOptions, skipInvalid, upsertBy: upsert ? 'page_id' : null,
  }), [source, hasHeader, map, decimal, delim, svc.zone, createOptions, skipInvalid, upsert])
  const plan = useMemo(() => {
    try { return planImport(worldOf(svc.state), data, options) } catch (e) { return { rows: [], problems: [{ row: 0, column: 0, propertyId: null, message: e instanceof Error ? e.message : String(e) }], newOptions: {}, inferred: [] } }
  }, [svc, data, options])
  const body = hasHeader ? data.slice(1) : data
  const go = async () => {
    setBusy(true)
    const r = await svc.tryExec([{ type: 'csv.import', payload: { data, options } as unknown as Json }])
    setBusy(false)
    if (r.ok) { const res = r.result as { created: number; updated: number }; notify(t('Imported {n} new and {m} updated items.', { n: res.created, m: res.updated })); onClose() }
    else setErr(errorText(r.code, r.message))
  }
  return (
    <div className="overlay dlg-overlay" onMouseDown={onClose}>
      <div className="modal db-modal wide" role="dialog" aria-modal="true" aria-label={t('Import CSV')} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><b>{t('Import “{n}”', { n: fileName })}</b><button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Ic.Close /></button></div>
        <div className="db-modal-body">
          <Switch label={t('The first row contains column names')} on={hasHeader} onChange={(v) => { setHasHeader(v); setMap(Array.from({ length: cols }, () => 'skip')) }} />
          <div className="db-map">
            {Array.from({ length: cols }, (_, i) => (
              <div className="db-map-row" key={i}>
                <span className="db-map-col" dir="auto">{header[i] || t('Column {n}', { n: i + 1 })}<small dir="auto">{body.slice(0, 2).map((r) => r[i]).filter(Boolean).join(' · ')}</small></span>
                <Ic.Arrow size={12} />
                <Select value={String(map[i])} options={[{ value: 'skip', label: t('Skip this column') }, ...(upsert ? [{ value: 'page_id', label: t('Item id (update existing)') }] : []), ...props.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => setMap(map.map((m, j) => (j === i ? v : m)))} />
              </div>
            ))}
          </div>
          <Field label={t('Decimal separator')}><Seg value={decimal} onChange={setDecimal} options={[{ value: '.', label: '1.5' }, { value: ',', label: '1,5' }, { value: '٫', label: '۱٫۵' }]} /></Field>
          <Field label={t('List separator')} hint={t('Needed for several values in one cell. Commas are never split unless you type one here.')}><input className="db-input sm" dir="ltr" value={delim} maxLength={3} onChange={(e) => setDelim(e.target.value)} /></Field>
          <Switch label={t('Create missing select options')} on={createOptions} onChange={setCreateOptions} />
          <Switch label={t('Skip cells that cannot be read (report them)')} on={skipInvalid} onChange={setSkipInvalid} />
          <Switch label={t('Update existing items that have the same id (advanced)')} on={upsert} onChange={setUpsert} />
          <div className="db-report">
            <div className="db-counts"><span className="ok">{t('{n} rows will be added', { n: plan.rows.length })}</span>{plan.problems.length > 0 && <span className="bad">{t('{n} problems', { n: plan.problems.length })}</span>}</div>
            {plan.problems.slice(0, 6).map((p, i) => <div key={i} className="db-sample bad" dir="auto">{p.row ? t('Row {r}, column {c}: ', { r: p.row, c: p.column + 1 }) : ''}{p.message}</div>)}
          </div>
          <div className="db-date-hint">{t('Import adds rows. Formulas, rollups and permissions are never read from a CSV file.')}</div>
          {err && <div className="db-err" role="alert">{err}</div>}
        </div>
        <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary" disabled={busy || (plan.problems.length > 0 && !skipInvalid) || !plan.rows.length} onClick={() => void go()}>{busy ? t('Importing…') : t('Import')}</button></div>
      </div>
    </div>
  )
}

// ───── restore ─────

function RestoreDialog({ svc, bundle, onClose, notify }: { svc: DatabaseService; bundle: Bundle; onClose: () => void; notify: (m: string) => void }) {
  const [mode, setMode] = useState<'replace' | 'merge'>('merge')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const counts = bundle.counts
  const go = async () => {
    if (mode === 'replace' && !(await confirmDialog({ title: t('Replace the current database records?'), message: t('A snapshot of the current records is downloaded first. Current sharing permissions are kept.'), danger: true, confirmLabel: t('Replace') }))) return
    setBusy(true)
    // pre-restore snapshot: always before anything changes
    download(`pre-restore-${Date.now()}.noviq-database.json`, new Blob([JSON.stringify(buildBundle(svc.state))], { type: 'application/json' }))
    const r = await svc.tryExec([{ type: 'backup.restore', payload: { bundle: bundle as unknown as Json, expectedManifestHash: bundle.manifestHash, mode, retainCurrentGrants: true } }])
    setBusy(false)
    if (r.ok) { notify(t('Restored {n} records.', { n: (r.result as { restored: number }).restored })); onClose() } else setErr(errorText(r.code, r.message))
  }
  return (
    <div className="overlay dlg-overlay" onMouseDown={onClose}>
      <div className="modal db-modal" role="dialog" aria-modal="true" aria-label={t('Restore')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>{t('Restore a database backup')}</b><button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Ic.Close /></button></div>
        <div className="db-modal-body">
          <p>{t('Backup of {d}', { d: new Date(bundle.createdAt).toLocaleString() })}</p>
          <ul className="db-counts-list">{Object.entries(counts).map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul>
          <Field label={t('How')}><Seg value={mode} onChange={setMode} options={[{ value: 'merge', label: t('Add next to what exists') }, { value: 'replace', label: t('Replace') }]} /></Field>
          <div className="db-date-hint">{mode === 'merge' ? t('Everything is added with new ids; nothing existing changes.') : t('Pages and files are restored with the page backup; this restores the database definitions, views and links.')}</div>
          {err && <div className="db-err" role="alert">{err}</div>}
        </div>
        <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className={'primary' + (mode === 'replace' ? ' danger' : '')} disabled={busy} onClick={() => void go()}>{t('Restore')}</button></div>
      </div>
    </div>
  )
}

export { promptDialog }
