// Import / export / backup of one database: CSV import wizard (explicit mapping, nothing guessed), CSV / Markdown export of the
// current view, native bundle backup and validated restore, schema or full duplicate. The container puts the items in its More menu.
import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { Container, Id, Json, View } from '../model/types.ts'
import { buildBundle, validateBundle, type Bundle } from '../backup2.ts'
import { exportCsv, exportMarkdown, parseCsv, planImport, worldOf, type ColumnMap, type ImportOptions } from '../csv.ts'
import { DESCRIPTORS } from '../props/registry.ts'
import type { DatabaseService } from '../service.ts'
import { download } from '../../backup'
import { Button, Dialog, Dropdown, Facts, Field, FormField, Icon, Segmented, SwitchRow, type MenuItem } from '../../design-system'
import { confirmDialog } from '../../dialog'
import { t } from '../../i18n'
import { ErrorLine, Hint, errorText } from './common'

const slug = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'database'

/** Menu items for import, export, backup and duplicate, plus the hidden file inputs and dialogs they open. */
export function useImportExport({
  svc,
  container,
  source,
  view,
  notify,
  canSchema,
}: {
  svc: DatabaseService
  container: Container
  source: Id | null
  view: View
  notify: (m: string) => void
  canSchema: boolean
}): { items: MenuItem[]; ui: ReactNode } {
  const [wizard, setWizard] = useState<{ data: string[][]; name: string } | null>(null)
  const [restore, setRestore] = useState<Bundle | null>(null)
  const csvInput = useRef<HTMLInputElement>(null)
  const bundleInput = useRef<HTMLInputElement>(null)
  const name = slug(container.title)
  const exportAs = (kind: 'csv' | 'md', safe: boolean) => {
    if (!source) return
    const personal = (() => {
      try {
        return JSON.parse(localStorage.getItem('db.personal.' + view.id) ?? 'null') as { filter?: never; sorts?: never } | null
      } catch {
        return null
      }
    })()
    const query = { filter: personal?.filter !== undefined ? personal.filter : view.filter, sorts: personal?.sorts ?? view.sorts }
    const o = { sourceId: source, principalId: svc.principalId, now: svc.nowIso(), zone: svc.zone, query, safe, propertyIds: (view.configuration as { visibleProperties?: Id[] }).visibleProperties }
    if (kind === 'csv') download(`${name}.csv`, new Blob([exportCsv(svc.state, o)], { type: 'text/csv;charset=utf-8' }))
    else download(`${name}.md`, new Blob([exportMarkdown(svc.state, o)], { type: 'text/markdown;charset=utf-8' }))
  }
  const duplicate = async (withRows: boolean) => {
    const r = await svc.tryExec([{ type: 'database.duplicate', payload: { containerId: container.id, withRows } }])
    notify(r.ok ? t(withRows ? 'Duplicated with all items.' : 'Duplicated (structure only).') : errorText(r.code, r.message))
  }
  const hasRows = !!source
  const items: MenuItem[] = [
    { label: 'Import CSV…', icon: <Icon name="upload" size={16} />, disabled: !hasRows, onSelect: () => csvInput.current?.click() },
    {
      label: 'Export this view',
      icon: <Icon name="download" size={16} />,
      items: [
        { label: 'CSV (safe for spreadsheets)', disabled: !hasRows, onSelect: () => exportAs('csv', true) },
        { label: 'CSV (raw values)', disabled: !hasRows, onSelect: () => exportAs('csv', false) },
        { label: 'Markdown table', disabled: !hasRows, onSelect: () => exportAs('md', true) },
        { kind: 'sep' },
        { label: 'Print', icon: <Icon name="printer" size={16} />, onSelect: () => window.setTimeout(() => window.print(), 50) },
      ],
    },
    {
      label: 'Backup',
      icon: <Icon name="save" size={16} />,
      items: [
        { label: 'Export the whole database (restorable)', onSelect: () => download(`${name}.nevis-database.json`, new Blob([JSON.stringify(buildBundle(svc.state))], { type: 'application/json' })) },
        { label: 'Restore from a database backup…', disabled: !canSchema, onSelect: () => bundleInput.current?.click() },
      ],
    },
    {
      label: 'Duplicate database',
      icon: <Icon name="copy" size={16} />,
      disabled: !canSchema,
      items: [
        { label: 'Duplicate with all items', disabled: !canSchema, onSelect: () => void duplicate(true) },
        { label: 'Duplicate structure only', disabled: !canSchema, onSelect: () => void duplicate(false) },
      ],
    },
  ]
  const ui = (
    <>
      <input
        ref={csvInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          try {
            setWizard({ data: parseCsv(await f.text()), name: f.name })
          } catch (err) {
            notify(String(err instanceof Error ? err.message : err))
          }
        }}
      />
      <input
        ref={bundleInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          try {
            const b = JSON.parse(await f.text())
            const problems = validateBundle(b).filter((p) => p.severity === 'error')
            if (problems.length) return notify(t('This is not a valid database backup: {m}', { m: problems[0].detail }))
            setRestore(b)
          } catch {
            notify(t('Not a valid JSON file.'))
          }
        }}
      />
      {wizard && source && <CsvWizard svc={svc} source={source} data={wizard.data} fileName={wizard.name} onClose={() => setWizard(null)} notify={notify} />}
      {restore && <RestoreDialog svc={svc} bundle={restore} onClose={() => setRestore(null)} notify={notify} />}
    </>
  )
  return { items, ui }
}

// ───── CSV wizard ─────

function CsvWizard({ svc, source, data, fileName, onClose, notify }: { svc: DatabaseService; source: Id; data: string[][]; fileName: string; onClose: () => void; notify: (m: string) => void }) {
  const props = svc.state.props(source).filter((p) => p.kind === 'title' || DESCRIPTORS[p.kind].writable || p.kind === 'relation')
  // the title is imported through its own target, not as a property id
  const targetOf = (p: (typeof props)[number]): ColumnMap['target'] => (p.kind === 'title' ? 'title' : p.id)
  const cols = Math.max(0, ...data.map((r) => r.length))
  const [hasHeader, setHasHeader] = useState(true)
  const header = hasHeader ? (data[0] ?? []) : []
  const guess = (i: number): ColumnMap['target'] => {
    const h = (header[i] ?? '').trim().toLowerCase()
    const hit = props.find((p) => p.name.trim().toLowerCase() === h)
    return hit ? targetOf(hit) : i === 0 && !header.length ? 'title' : 'skip'
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
  const options: ImportOptions = useMemo(
    () => ({
      sourceId: source,
      sessionId: session.current,
      hasHeader,
      columns: map.map((target, column) => ({ column, target })),
      decimalSeparator: decimal,
      listDelimiter: delim || undefined,
      zone: svc.zone,
      createOptions,
      skipInvalid,
      upsertBy: upsert ? 'page_id' : null,
    }),
    [source, hasHeader, map, decimal, delim, svc.zone, createOptions, skipInvalid, upsert],
  )
  const plan = useMemo(() => {
    try {
      return planImport(worldOf(svc.state), data, options)
    } catch (e) {
      return { rows: [], problems: [{ row: 0, column: 0, propertyId: null, message: e instanceof Error ? e.message : String(e) }], newOptions: {}, inferred: [] }
    }
  }, [svc, data, options])
  const body = hasHeader ? data.slice(1) : data
  const go = async () => {
    setBusy(true)
    const r = await svc.tryExec([{ type: 'csv.import', payload: { data, options } as unknown as Json }])
    setBusy(false)
    if (r.ok) {
      const res = r.result as { created: number; updated: number }
      notify(t('Imported {n} new and {m} updated items.', { n: res.created, m: res.updated }))
      onClose()
    } else setErr(errorText(r.code, r.message))
  }
  return (
    <Dialog
      open
      wide
      title={t('Import “{n}”', { n: fileName })}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" disabled={busy || (plan.problems.length > 0 && !skipInvalid) || !plan.rows.length} onClick={() => void go()}>
            {busy ? t('Importing…') : t('Import {n} rows', { n: plan.rows.length })}
          </Button>
        </>
      }
    >
      <div className="ds-modal-body">
        <SwitchRow
          label={t('The first row contains column names')}
          checked={hasHeader}
          onChange={(v) => {
            setHasHeader(v)
            setMap(Array.from({ length: cols }, () => 'skip'))
          }}
        />
        <div className="dv-mapping" role="table" aria-label={t('Columns')}>
          {Array.from({ length: cols }, (_, i) => (
            <div className="dv-mapping-row" role="row" key={i}>
              <span className="dv-mapping-col" role="cell">
                <b dir="auto">{header[i] || t('Column {n}', { n: i + 1 })}</b>
                <small dir="auto">
                  {body
                    .slice(0, 2)
                    .map((r) => r[i])
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
              <Icon name="arrow-right" size={16} className="ds-flip" />
              <span role="cell">
                <Dropdown
                  label={t('Import into')}
                  value={String(map[i])}
                  options={[{ value: 'skip', label: 'Skip this column' }, ...(upsert ? [{ value: 'page_id', label: 'Item id (update existing)' }] : []), ...props.map((p) => ({ value: String(targetOf(p)), label: p.name, raw: true }))]}
                  onChange={(v) => setMap(map.map((m, j) => (j === i ? v : m)))}
                />
              </span>
            </div>
          ))}
        </div>
        <div className="dv-pair">
          <FormField label={t('Decimal separator')}>
            <Segmented
              label={t('Decimal separator')}
              value={decimal}
              onChange={setDecimal}
              options={[
                { value: '.', label: '1.5' },
                { value: ',', label: '1,5' },
                { value: '٫', label: '۱٫۵' },
              ]}
            />
          </FormField>
          <FormField label={t('List separator')} hint={t('Needed for several values in one cell. Commas are never split unless you type one here.')}>
            <Field ltr value={delim} maxLength={3} onChange={(e) => setDelim(e.target.value)} />
          </FormField>
        </div>
        <SwitchRow label={t('Create missing select options')} checked={createOptions} onChange={setCreateOptions} />
        <SwitchRow label={t('Skip cells that cannot be read (report them)')} checked={skipInvalid} onChange={setSkipInvalid} />
        <SwitchRow label={t('Update existing items that have the same id (advanced)')} checked={upsert} onChange={setUpsert} />
        <div className="dv-report">
          <p className="dv-report-line">
            {t('{n} rows will be added', { n: plan.rows.length })}
            {plan.problems.length > 0 && (
              <>
                {' · '}
                <b data-bad>{t('{n} problems', { n: plan.problems.length })}</b>
              </>
            )}
          </p>
          {plan.problems.length > 0 && (
            <ul className="dv-samples">
              {plan.problems.slice(0, 6).map((p, i) => (
                <li key={i} data-bad dir="auto">
                  {p.row ? t('Row {r}, column {c}: ', { r: p.row, c: p.column + 1 }) : ''}
                  {p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Hint>{t('Import adds rows. Formulas, rollups and permissions are never read from a CSV file.')}</Hint>
        {err && <ErrorLine>{err}</ErrorLine>}
      </div>
    </Dialog>
  )
}

// ───── restore ─────

function RestoreDialog({ svc, bundle, onClose, notify }: { svc: DatabaseService; bundle: Bundle; onClose: () => void; notify: (m: string) => void }) {
  const [mode, setMode] = useState<'replace' | 'merge'>('merge')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (
      mode === 'replace' &&
      !(await confirmDialog({
        title: t('Replace the current database records?'),
        message: t('A snapshot of the current records is downloaded first. Current sharing permissions are kept.'),
        danger: true,
        confirmLabel: t('Replace'),
      }))
    )
      return
    setBusy(true)
    // pre-restore snapshot: always before anything changes
    download(`pre-restore-${Date.now()}.nevis-database.json`, new Blob([JSON.stringify(buildBundle(svc.state))], { type: 'application/json' }))
    const r = await svc.tryExec([{ type: 'backup.restore', payload: { bundle: bundle as unknown as Json, expectedManifestHash: bundle.manifestHash, mode, retainCurrentGrants: true } }])
    setBusy(false)
    if (r.ok) {
      notify(t('Restored {n} records.', { n: (r.result as { restored: number }).restored }))
      onClose()
    } else setErr(errorText(r.code, r.message))
  }
  return (
    <Dialog
      open
      title={t('Restore a database backup')}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant={mode === 'replace' ? 'danger' : 'primary'} disabled={busy} onClick={() => void go()}>
            {t('Restore')}
          </Button>
        </>
      }
    >
      <div className="ds-modal-body">
        <p className="dv-text">{t('Backup of {d}', { d: new Date(bundle.createdAt).toLocaleString() })}</p>
        <Facts items={Object.entries(bundle.counts).map(([k, n]) => [k, String(n)] as [string, string])} />
        <FormField label={t('How')}>
          <Segmented
            label={t('How')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'merge', label: t('Add next to what exists') },
              { value: 'replace', label: t('Replace') },
            ]}
          />
        </FormField>
        <Hint>
          {mode === 'merge' ? t('Everything is added with new ids; nothing existing changes.') : t('Pages and files are restored with the page backup; this restores the database definitions, views and links.')}
        </Hint>
        {err && <ErrorLine>{err}</ErrorLine>}
      </div>
    </Dialog>
  )
}
