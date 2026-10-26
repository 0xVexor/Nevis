// Property schema UI: the type picker, per-kind settings, option manager, formula editor, conversion dialog and the column menu.
import { useMemo, useState } from 'react'
import type { Definition, Id, Json, Kind } from '../model/types.ts'
import { compileFormula } from '../formula/compile.ts'
import { registryTable } from '../formula/functions.ts'
import { previewConversion, type ConvertPlan, type ConversionReport } from '../commands/convert.ts'
import { optionsOf, ROLLUP_AGGREGATIONS, statusConfig, type RollupAggregation } from '../props/config.ts'
import { CURRENCIES } from '../props/numberFormat.ts'
import { DESCRIPTORS } from '../props/registry.ts'
import { schemaFor, staticType } from '../resolver.ts'
import type { DatabaseService } from '../service.ts'
import { confirmDialog, promptDialog } from '../../dialog'
import { Popover, MenuItem, MenuLabel, MenuSep, Select } from '../../ui'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { Chip, KIND_LABEL, KindIcon, OPTION_COLOR_LIST, PICKABLE_KINDS, errorText } from './common'
import { Field, Seg, Switch } from './forms'

// ───── options manager ─────

export function OptionsManager({ svc, def }: { svc: DatabaseService; def: Definition }) {
  const opts = optionsOf(def)
  const groups = def.kind === 'status' ? statusConfig(def.config).groups : []
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [colorFor, setColorFor] = useState<{ id: Id; rect: DOMRect } | null>(null)
  const run = async (cmds: { type: string; payload: Json }[]) => {
    const r = await svc.tryExec(cmds)
    setErr(r.ok ? null : errorText(r.code, r.message))
    return r.ok
  }
  const add = async (groupId?: Id) => {
    if (!adding.trim()) return
    if (await run([{ type: 'option.upsert', payload: { propertyId: def.id, name: adding.trim(), color: 'default', ...(groupId ? { statusGroupId: groupId } : def.kind === 'status' ? { statusGroupId: groups[0].id } : {}) } }])) setAdding('')
  }
  const del = async (o: { id: Id; name: string }) => {
    let replacement: Id | undefined
    const cfg = def.kind === 'status' ? statusConfig(def.config) : null
    const used = svc.state.rows(def.sourceId).some((r) => { const c = r.ext.cells[def.id]?.value; return c && ((c.kind === 'status' || c.kind === 'select') ? c.optionId === o.id : c.kind === 'multi_select' && c.optionIds.includes(o.id)) })
    if (cfg && (cfg.defaultOptionId === o.id || used)) {
      const others = cfg.options.filter((x) => x.id !== o.id)
      if (!others.length) return setErr(t('A status needs at least one option.'))
      const name = await promptDialog({ title: t('Replace “{n}” with…', { n: o.name }), message: t('Type the name of an existing option: items using “{n}” move to it.', { n: o.name }), initial: others[0].name })
      if (!name) return
      replacement = others.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())?.id
      if (!replacement) return setErr(t('No option with that name.'))
    } else if (used && !(await confirmDialog({ title: t('Delete option “{n}”?', { n: o.name }), message: t('Items that use it will have no value for this property.'), danger: true }))) return
    await run([{ type: 'option.delete', payload: { propertyId: def.id, optionId: o.id, ...(replacement ? { replacementOptionId: replacement } : {}) } }])
  }
  const move = async (id: Id, dir: -1 | 1) => {
    const i = opts.findIndex((o) => o.id === id)
    const target = opts[i + dir]
    if (!target) return
    const before = dir < 0 ? target.id : opts[i + 2]?.id
    await run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: id, name: opts[i].name, ...(before ? { beforeOptionId: before } : {}) } }])
  }
  return (
    <div className="db-options">
      {opts.map((o, i) => (
        <div className="db-opt-row" key={o.id}>
          <button type="button" className={'db-swatch ' + 'dbc-' + o.color} aria-label={t('Color')} onClick={(e) => setColorFor({ id: o.id, rect: e.currentTarget.getBoundingClientRect() })} />
          <input className="db-input" defaultValue={o.name} dir="auto" aria-label={t('Option name')} onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: o.id, name: e.target.value.trim() } }])} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
          {def.kind === 'status' && (
            <Select value={(o as unknown as { statusGroupId: Id }).statusGroupId} options={groups.map((g) => ({ value: g.id, label: g.label }))} onChange={(g) => void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: o.id, name: o.name, statusGroupId: g } }])} />
          )}
          <button type="button" className="icon-btn" aria-label={t('Move up')} disabled={i === 0} onClick={() => void move(o.id, -1)}><Ic.Up size={12} /></button>
          <button type="button" className="icon-btn" aria-label={t('Move down')} disabled={i === opts.length - 1} onClick={() => void move(o.id, 1)}><span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}><Ic.Up size={12} /></span></button>
          <button type="button" className="icon-btn" aria-label={t('Delete option')} onClick={() => void del(o)}><Ic.Trash size={12} /></button>
        </div>
      ))}
      <div className="db-opt-row">
        <input className="db-input" placeholder={t('Add an option…')} value={adding} dir="auto" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void add()} />
        <button type="button" className="primary" onClick={() => void add()}>{t('Add')}</button>
      </div>
      {err && <div className="db-err" role="alert">{err}</div>}
      {colorFor && (
        <div className="db-colors-in">
          <div className="db-colors">
            {OPTION_COLOR_LIST.map((c) => (
              <button key={c} type="button" className={'db-swatch dbc-' + c} aria-label={c} onClick={() => (void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: colorFor.id, name: opts.find((o) => o.id === colorFor.id)!.name, color: c } }]), setColorFor(null))} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ───── formula editor ─────

export function FormulaEditor({ svc, sourceId, selfId, source, onChange }: { svc: DatabaseService; sourceId: Id; selfId: Id | null; source: string; onChange: (s: string) => void }) {
  const [help, setHelp] = useState(false)
  const result = useMemo(() => compileFormula(source, schemaFor(svc.state, sourceId, selfId ?? undefined)), [svc, sourceId, selfId, source, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const props = svc.state.props(sourceId).filter((p) => p.id !== selfId && p.kind !== 'button')
  const fns = useMemo(() => registryTable(), [])
  const insert = (txt: string) => onChange(source + txt)
  return (
    <div className="db-formula">
      <textarea className="db-input mono" dir="ltr" rows={4} spellCheck={false} aria-label={t('Formula')} value={source} onChange={(e) => onChange(e.target.value)} placeholder={'prop("Price") * 2'} />
      {source.trim() && !result.ok && result.diagnostics.map((d, i) => <div key={i} className="db-err" role="alert" dir="ltr">{d.code}: {d.message} {source ? `(${d.from}–${d.to})` : ''}</div>)}
      {source.trim() && result.ok && <div className="db-ok" dir="ltr">✓ {t('Result type')}: {result.resultType}</div>}
      <div className="db-chips-row">
        {props.map((p) => <button key={p.id} type="button" className="db-chip" onClick={() => insert(`prop(${JSON.stringify(p.name)})`)} title={t('Insert property')}><KindIcon kind={p.kind} /> {p.name}</button>)}
      </div>
      <button type="button" className="db-linkbtn" onClick={() => setHelp(!help)}>{help ? t('Hide functions') : t('Show functions')}</button>
      {help && (
        <div className="db-fn-list" dir="ltr">
          {fns.map((f) => <div key={f.name}><button type="button" className="db-fn" onClick={() => insert(`${f.name}(`)}>{f.name}({f.params.join(', ')})</button><small> — {f.doc}</small></div>)}
        </div>
      )}
    </div>
  )
}

// ───── per-kind settings ─────

type Cfg = Record<string, Json>

const CONNECTED_PROVIDERS: [string, string][] = [['github_pr', 'GitHub pull request'], ['gdrive', 'Google Drive file'], ['figma', 'Figma file'], ['zendesk', 'Zendesk ticket']]
const REMINDER_CHOICES: [number, string][] = [[0, 'At the time'], [10, '10 minutes before'], [60, '1 hour before'], [1440, '1 day before'], [2880, '2 days before']]

export function ConfigForm({ svc, kind, sourceId, selfId, config, onChange }: { svc: DatabaseService; kind: Kind; sourceId: Id; selfId: Id | null; config: Cfg; onChange: (c: Cfg) => void }) {
  const set = (patch: Cfg) => onChange({ ...config, ...patch })
  const sources = svc.state.live('source').filter((s) => svc.access().sourceCaps(svc.principalId, s.id).has('read'))
  switch (kind) {
    case 'number': {
      const fmt = (config.format as string) ?? 'plain'
      const prog = config.progress as { mode: string; target: number; color: string } | undefined
      return (
        <>
          <Field label={t('Format')}>
            <Seg value={fmt} onChange={(v) => set({ format: v })} options={[{ value: 'plain', label: t('Number') }, { value: 'grouped', label: t('Grouped') }, { value: 'percent', label: t('Percent') }, { value: 'currency', label: t('Currency') }]} />
          </Field>
          {fmt === 'currency' && <Field label={t('Currency')}><Select value={(config.currencyCode as string) ?? 'USD'} options={CURRENCIES.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ currencyCode: v })} /></Field>}
          <Field label={t('Decimal places')} hint={t('Only changes how the number is shown, never the stored value.')}>
            <input className="db-input" type="number" min={0} max={12} dir="ltr" value={(config.precision as number) ?? 0} onChange={(e) => set({ precision: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
          </Field>
          <Switch label={t('Show as progress')} on={!!prog} onChange={(on) => set({ progress: on ? { mode: 'bar', target: 100, color: 'green' } : null })} />
          {prog && (
            <>
              <Seg value={prog.mode} onChange={(v) => set({ progress: { ...prog, mode: v } })} options={[{ value: 'bar', label: t('Bar') }, { value: 'ring', label: t('Ring') }]} />
              <Field label={t('Full at')}><input className="db-input" type="number" dir="ltr" value={prog.target} onChange={(e) => set({ progress: { ...prog, target: Number(e.target.value) || 100 } })} /></Field>
            </>
          )}
        </>
      )
    }
    case 'select':
    case 'multi_select':
    case 'status': {
      if (selfId) {
        const def = svc.state.prop(selfId)
        return def ? <OptionsManager svc={svc} def={def} /> : null
      }
      const names = (config.optionNames as string) ?? ''
      return <Field label={t('Options')} hint={t('One per line. You can change them later.')}><textarea className="db-input" rows={4} dir="auto" value={names} onChange={(e) => set({ optionNames: e.target.value, options: e.target.value.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ name })) })} /></Field>
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return (
        <>
          <Field label={t('Calendar')}><Seg value={(config.displayCalendar as string) ?? 'gregorian'} onChange={(v) => set({ displayCalendar: v })} options={[{ value: 'gregorian', label: t('Gregorian') }, { value: 'jalali', label: t('Jalali') }]} /></Field>
          <Field label={t('Time')}><Seg value={(config.timeFormat as string) ?? '24h'} onChange={(v) => set({ timeFormat: v })} options={[{ value: '24h', label: '24h' }, { value: '12h', label: '12h' }, { value: 'none', label: t('Hidden') }]} /></Field>
          {kind === 'date' && (
            <Field label={t('Reminders')} hint={t('Shown in the app (and as a system notification if you allow it) while the app is open. Dates without a time remind relative to 09:00.')}>
              <div role="group" aria-label={t('Reminders')}>
                {REMINDER_CHOICES.map(([min, label]) => {
                  const cur = ((config.reminders as { offsetMinutes: number }[]) ?? []).map((r) => r.offsetMinutes)
                  return <label key={min} className="db-radio"><input type="checkbox" checked={cur.includes(min)} onChange={(e) => set({ reminders: (e.target.checked ? [...cur, min] : cur.filter((x) => x !== min)).sort((a, b) => a - b).map((offsetMinutes) => ({ offsetMinutes })) })} /> {t(label)}</label>
                })}
              </div>
            </Field>
          )}
        </>
      )
    case 'people': return <Switch label={t('Allow several people')} on={config.multiple !== false} onChange={(v) => set({ multiple: v })} />
    case 'files':
      return (
        <>
          <Field label={t('Allowed types')} hint={t('Comma separated, e.g. image/*, application/pdf. Empty allows everything.')}>
            <input className="db-input" dir="ltr" value={((config.allowedTypes as string[]) ?? []).join(', ')} onChange={(e) => set({ allowedTypes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          </Field>
        </>
      )
    case 'relation': {
      const target = (config.targetSourceId as string) ?? svc.state.get('source', sourceId)?.id
      const self = target === sourceId
      return (
        <>
          <Field label={t('Related to')}><Select value={target ?? ''} options={sources.map((s) => ({ value: s.id, label: s.name }))} onChange={(v) => set({ targetSourceId: v, mode: v === sourceId ? (config.mode ?? 'paired') : config.mode === 'self_symmetric' ? 'one_way' : config.mode })} /></Field>
          <Field label={t('Direction')}>
            <Seg value={(config.mode as string) ?? 'one_way'} onChange={(v) => set({ mode: v })} options={[{ value: 'one_way', label: t('One way') }, { value: 'paired', label: t('Two way') }, ...(self ? [{ value: 'self_symmetric', label: t('Mutual') }] : [])]} />
          </Field>
          <Field label={t('Links per item')}><Seg value={(config.cardinality as string) ?? 'many'} onChange={(v) => set({ cardinality: v })} options={[{ value: 'many', label: t('Many') }, { value: 'one', label: t('One') }]} /></Field>
          {config.mode === 'paired' && (
            <>
              <Field label={t('Name of the reverse property')}><input className="db-input" dir="auto" value={(config.inverseName as string) ?? ''} onChange={(e) => set({ inverseName: e.target.value })} /></Field>
              <Field label={t('Reverse links per item')}><Seg value={(config.inverseCardinality as string) ?? 'many'} onChange={(v) => set({ inverseCardinality: v })} options={[{ value: 'many', label: t('Many') }, { value: 'one', label: t('One') }]} /></Field>
            </>
          )}
        </>
      )
    }
    case 'rollup': {
      const rels = svc.state.props(sourceId).filter((p) => p.kind === 'relation')
      const relId = (config.relationPropertyId as string) ?? rels[0]?.id
      const rel = relId ? svc.state.relationOf(relId) : undefined
      const targetSource = rel ? (rel.propertyId === relId ? rel.targetSourceId : rel.sourceId) : undefined
      const tprops = targetSource ? svc.state.props(targetSource).filter((p) => p.kind !== 'rollup' && p.kind !== 'button') : []
      return (
        <>
          <Field label={t('Relation')}><Select value={relId ?? ''} options={rels.map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => set({ relationPropertyId: v, targetPropertyId: '' })} /></Field>
          <Field label={t('Property')}><Select value={(config.targetPropertyId as string) ?? ''} options={[{ value: '', label: t('Choose…') }, ...tprops.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ targetPropertyId: v })} /></Field>
          <Field label={t('Calculate')}><Select value={(config.aggregation as string) ?? 'count_all'} options={(ROLLUP_AGGREGATIONS as string[]).map((a) => ({ value: a, label: t(AGG_LABEL[a as RollupAggregation]) }))} onChange={(v) => set({ aggregation: v })} /></Field>
          {rels.length === 0 && <div className="db-date-hint">{t('Add a relation property first.')}</div>}
        </>
      )
    }
    case 'formula': return <FormulaEditor svc={svc} sourceId={sourceId} selfId={selfId} source={(config.source as string) ?? ''} onChange={(s) => set({ source: s })} />
    case 'unique_id':
      return (
        <>
          <Field label={t('Prefix')}><input className="db-input" dir="ltr" maxLength={12} value={(config.prefix as string) ?? ''} onChange={(e) => set({ prefix: e.target.value })} placeholder="TASK" /></Field>
          <Field label={t('Numbering')} hint={(config.allocationMode ?? 'partitioned') === 'sequential' ? t('Strictly increasing numbers (TASK-1, TASK-2…). Use this when only one device creates items, or a shared server hands out numbers.') : t('Each device numbers its own items (TASK-ab12-1). No two devices ever clash, even offline. Numbers are never changed later.')}>
            <Seg value={(config.allocationMode as string) ?? 'partitioned'} onChange={(v) => set({ allocationMode: v })} options={[{ value: 'partitioned', label: t('Per device (safe offline)') }, { value: 'sequential', label: t('Sequential') }]} />
          </Field>
        </>
      )
    case 'button':
      return (
        <>
          <Field label={t('Button label')}><input className="db-input" dir="auto" value={(config.label as string) ?? ''} onChange={(e) => set({ label: e.target.value })} /></Field>
          <div className="db-date-hint">{t('After creating the button, choose what it does from its menu → Edit actions.')}</div>
        </>
      )
    case 'verification': return <Field label={t('Verification expires')}><Select value={(config.expiryPolicy as string) ?? 'never'} options={['never', '7d', '30d', '90d', '180d'].map((v) => ({ value: v, label: v === 'never' ? t('Never') : t('After {n} days', { n: v.replace('d', '') }) }))} onChange={(v) => set({ expiryPolicy: v })} /></Field>
    case 'connected':
      return (
        <>
          <Field label={t('Service')}><Select value={(config.providerId as string) ?? 'github_pr'} options={CONNECTED_PROVIDERS.map(([value, label]) => ({ value, label }))} onChange={(v) => set({ providerId: v })} /></Field>
          <Field label={t('Connection name')} hint={t('Names a connection set up on your gateway. The secret never enters your notes.')}>
            <input className="db-input" dir="ltr" value={(config.connectionId as string) ?? 'default'} onChange={(e) => set({ connectionId: e.target.value.trim() || 'default' })} />
          </Field>
        </>
      )
    case 'place': return <div className="db-date-hint">{t('Coordinates are typed by hand and work offline. Address lookup needs a map provider; nothing is looked up automatically.')}</div>
    default: return null
  }
}

const AGG_LABEL: Record<RollupAggregation, string> = {
  count_all: 'Count all', count_values: 'Count values', count_unique: 'Count unique values', count_empty: 'Count empty', count_not_empty: 'Count not empty',
  percent_empty: 'Percent empty', percent_not_empty: 'Percent not empty', checked: 'Checked', unchecked: 'Unchecked', percent_checked: 'Percent checked',
  percent_unchecked: 'Percent unchecked', sum: 'Sum', average: 'Average', median: 'Median', min: 'Min', max: 'Max', range: 'Range', earliest_date: 'Earliest date',
  latest_date: 'Latest date', date_range: 'Date range', show_original: 'Show original', show_unique: 'Show unique',
}
export const aggLabel = (a: RollupAggregation) => t(AGG_LABEL[a])

// ───── create ─────

export function NewPropertyPopover({ svc, sourceId, anchor, onClose, onCreated, beforeId }: { svc: DatabaseService; sourceId: Id; anchor: DOMRect; onClose: () => void; onCreated?: (id: Id) => void; beforeId?: Id }) {
  const [kind, setKind] = useState<Kind | null>(null)
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Cfg>({})
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const kinds = PICKABLE_KINDS.filter((k) => t(KIND_LABEL[k]).toLowerCase().includes(q.toLowerCase()))
  const create = async () => {
    if (!kind) return
    const nm = name.trim() || t(KIND_LABEL[kind])
    let cfg: Cfg = { ...config }
    if (kind === 'relation') cfg = { mode: 'one_way', ...cfg, targetSourceId: cfg.targetSourceId ?? sourceId }
    const r = await svc.tryExec([{ type: 'property.create', payload: { sourceId, name: nm, kind, config: cfg, ...(beforeId ? { beforePropertyId: beforeId } : {}) } }])
    if (!r.ok) return setErr(errorText(r.code, r.message))
    const res = r.result as { propertyId?: Id }
    if (kind === 'button') {
      // a button needs its workflow record; actions are edited from the column menu
      const pid = res.propertyId!
      await svc.tryExec([{ type: 'workflow.save', payload: { body: { sourceId, name: nm, kind: 'button', actions: [], triggers: [], triggerMode: 'any', viewScopeId: null, propertyId: pid } } }])
    }
    onCreated?.(res.propertyId!)
    onClose()
  }
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="db-pop wide" onClick={(e) => e.stopPropagation()}>
        {!kind ? (
          <>
            <input className="db-input" autoFocus placeholder={t('Search property types…')} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="db-types" role="listbox">
              {kinds.map((k) => (
                <button key={k} type="button" role="option" className="menu-item" onClick={() => { setKind(k); setName(''); setConfig(k === 'unique_id' ? { allocationMode: 'partitioned' } : k === 'connected' ? { providerId: 'github_pr', connectionId: 'default', exposedFields: [] } : {}) }}>
                  <span className="menu-ic"><KindIcon kind={k} /></span>
                  <span className="menu-tx">{t(KIND_LABEL[k])}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="db-form">
            <div className="db-form-head"><button type="button" className="icon-btn" aria-label={t('Back')} onClick={() => setKind(null)}><span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}><Ic.Chevron size={14} /></span></button><KindIcon kind={kind} /> <b>{t(KIND_LABEL[kind])}</b></div>
            <Field label={t('Name')}><input className="db-input" autoFocus dir="auto" value={name} placeholder={t(KIND_LABEL[kind])} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void create()} /></Field>
            <ConfigForm svc={svc} kind={kind} sourceId={sourceId} selfId={null} config={config} onChange={setConfig} />
            {err && <div className="db-err" role="alert">{err}</div>}
            <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary" onClick={() => void create()}>{t('Create')}</button></div>
          </div>
        )}
      </div>
    </Popover>
  )
}

// ───── conversion dialog ─────

const CONVERT_TARGETS: Kind[] = ['text', 'number', 'select', 'multi_select', 'status', 'date', 'people', 'checkbox', 'url', 'email', 'phone', 'place', 'relation', 'formula']

export function ConvertDialog({ svc, def, onClose }: { svc: DatabaseService; def: Definition; onClose: () => void }) {
  const [to, setTo] = useState<Kind>(def.kind === 'text' ? 'number' : 'text')
  const [policy, setPolicy] = useState<'rejectInvalid' | 'clearInvalid'>('rejectInvalid')
  const [decimal, setDecimal] = useState('.')
  const [create, setCreate] = useState(true)
  const [delim, setDelim] = useState('')
  const [dateFmt, setDateFmt] = useState('')
  const [pick, setPick] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const plan: ConvertPlan = useMemo(() => ({
    propertyId: def.id, destinationKind: to, invalidPolicy: policy,
    ...(to === 'select' || to === 'multi_select' || to === 'status' ? { destinationConfig: from(def, to) } : {}),
    mapping: { decimalSeparator: decimal, autoCreateOptions: create, delimiter: delim || undefined, dateFormat: (dateFmt || undefined) as never, pick: pick ? 'first_by_order' : undefined, zone: svc.zone, timestampUnit: 'ms' },
  }), [def, to, policy, decimal, create, delim, dateFmt, pick, svc.zone])
  const report: ConversionReport | null = useMemo(() => {
    try {
      return previewConversion(svc.coord, plan, svc.zone).report
    } catch {
      return null
    }
  }, [svc, plan]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    const r = await svc.tryExec([{ type: 'property.convert_commit', payload: { plan: plan as unknown as Json } }])
    if (r.ok) onClose()
    else setErr(errorText(r.code, r.message))
  }
  return (
    <div className="overlay dlg-overlay" onMouseDown={onClose}>
      <div className="modal db-modal" role="dialog" aria-modal="true" aria-label={t('Change property type')} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><b>{t('Change “{n}” to…', { n: def.name })}</b><button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Ic.Close /></button></div>
        <div className="db-modal-body">
          <Field label={t('New type')}><Select value={to} options={CONVERT_TARGETS.filter((k) => k !== def.kind).map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))} onChange={(v) => setTo(v as Kind)} /></Field>
          {(def.kind === 'text') && (to === 'number') && <Field label={t('Decimal separator')}><Seg value={decimal} onChange={setDecimal} options={[{ value: '.', label: '. (1.5)' }, { value: ',', label: ', (1,5)' }, { value: '٫', label: '٫ (۱٫۵)' }]} /></Field>}
          {def.kind === 'text' && to === 'date' && <Field label={t('Date format')} hint={t('Without a format only ISO dates (2026-10-25) convert; ambiguous dates such as 01/02/03 are reported, not guessed.')}><Select value={dateFmt} options={[{ value: '', label: 'ISO (YYYY-MM-DD)' }, { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }, { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' }, { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD' }, { value: 'jalali', label: t('Jalali (YYYY/MM/DD)') }]} onChange={setDateFmt} /></Field>}
          {def.kind === 'text' && (to === 'select' || to === 'multi_select' || to === 'status') && (
            <>
              <Switch label={t('Create an option for every different text')} on={create} onChange={setCreate} />
              {to === 'multi_select' && <Field label={t('Split on')} hint={t('Commas are never split unless you choose a separator.')}><input className="db-input" dir="ltr" value={delim} maxLength={3} onChange={(e) => setDelim(e.target.value)} placeholder="," /></Field>}
            </>
          )}
          {def.kind === 'multi_select' && to === 'select' && <Switch label={t('When several are selected, keep the first by option order')} on={pick} onChange={setPick} />}
          {report && !report.supported && <div className="db-err">{report.unsupportedReason}</div>}
          {report?.supported && (
            <div className="db-report">
              <div className="db-counts"><span className="ok">{t('{n} convert cleanly', { n: report.counts.lossless })}</span><span className="warn">{t('{n} lose detail', { n: report.counts.lossy })}</span><span className="bad">{t('{n} cannot convert', { n: report.counts.invalid })}</span></div>
              {report.invalid.slice(0, 5).map((e) => <div key={e.pageId} className="db-sample bad" dir="auto">“{e.before}” — {e.reason}</div>)}
              {report.samples.filter((e) => e.loss !== 'invalid').slice(0, 5).map((e) => <div key={e.pageId} className="db-sample" dir="auto">{e.before || '∅'} → {e.after || '∅'}</div>)}
              {report.counts.invalid > 0 && <Field label={t('Cells that cannot convert')}><Seg value={policy} onChange={setPolicy} options={[{ value: 'rejectInvalid', label: t('Cancel the change') }, { value: 'clearInvalid', label: t('Clear them (originals are kept in history)') }]} /></Field>}
            </div>
          )}
          {err && <div className="db-err" role="alert">{err}</div>}
        </div>
        <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary" disabled={!report?.supported || (report.counts.invalid > 0 && policy === 'rejectInvalid')} onClick={() => void go()}>{t('Convert')}</button></div>
      </div>
    </div>
  )
}
function from(def: Definition, to: Kind): Json {
  if ((def.kind === 'select' || def.kind === 'multi_select') && (to === 'select' || to === 'multi_select')) return { options: optionsOf(def) } as unknown as Json
  return { options: [] }
}

// ───── column menu ─────

export type ColumnActions = {
  hide?: () => void
  freeze?: () => void
  sort?: (dir: 'asc' | 'desc') => void
  filter?: () => void
  insertAfter?: (kind?: Kind) => void
}

export function PropertyMenu({ svc, def, anchor, onClose, actions, onEditActions }: { svc: DatabaseService; def: Definition; anchor: DOMRect; onClose: () => void; actions: ColumnActions; onEditActions?: (def: Definition) => void }) {
  const [view, setView] = useState<'menu' | 'settings'>('menu')
  const [name, setName] = useState(def.name)
  const [config, setConfig] = useState<Cfg>(def.config as Cfg)
  const [convert, setConvert] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isTitle = def.kind === 'title'
  const canSchema = svc.access().sourceCaps(svc.principalId, def.sourceId).has('edit_schema')
  const hasSettings = !['title', 'text', 'checkbox', 'url', 'email', 'phone', 'created_by', 'last_edited_by', 'files'].includes(def.kind) || def.kind === 'files'
  const save = async () => {
    const patch: Record<string, Json> = {}
    if (name.trim() && name.trim() !== def.name) patch.name = name.trim()
    const noOpts = Object.fromEntries(Object.entries(config).filter(([k]) => !['options', 'groups', 'defaultOptionId', 'archivedOptions', 'definitionId', 'side', 'ast', 'resolvedRefs', 'resultType', 'languageVersion'].includes(k)))
    const r = await svc.tryExec([{ type: 'property.configure', payload: { propertyId: def.id, ...patch, ...(def.kind === 'formula' ? { configPatch: { source: (config.source as string) ?? '' } } : DESCRIPTORS[def.kind].storage === 'derived' || def.kind === 'relation' ? {} : { configPatch: noOpts as Json }) } }])
    if (!r.ok) return setErr(errorText(r.code, r.message))
    onClose()
  }
  const del = async () => {
    const deps = svc.state.live('property').filter((p) => (p.kind === 'formula' || p.kind === 'rollup') && JSON.stringify(p.config).includes(def.id) && p.id !== def.id)
    const ok = await confirmDialog({ title: t('Delete “{n}”?', { n: def.name }), message: deps.length ? t('{k} other properties depend on it and will show an error. You can restore it from the trash menu.', { k: deps.length }) : t('Its values are kept, so you can restore the property later.'), danger: true, confirmLabel: t('Delete') })
    if (!ok) return
    const r = await svc.tryExec([{ type: 'property.delete', payload: { propertyId: def.id } }])
    if (!r.ok) setErr(errorText(r.code, r.message))
    else onClose()
  }
  if (convert) return <ConvertDialog svc={svc} def={def} onClose={() => (setConvert(false), onClose())} />
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="db-pop wide" onClick={(e) => e.stopPropagation()}>
        {view === 'menu' ? (
          <div className="menu">
            <div className="db-form">
              <Field label={t('Name')}><input className="db-input" dir="auto" value={name} disabled={!canSchema} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== def.name && void save()} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void save()} /></Field>
              <div className="db-kind-line"><KindIcon kind={def.kind} /> {t(KIND_LABEL[def.kind])}</div>
            </div>
            {err && <div className="db-err" role="alert">{err}</div>}
            <MenuSep />
            {canSchema && hasSettings && <MenuItem icon={<Ic.Settings size={14} />} label={t('Edit property')} onClick={() => setView('settings')} />}
            {canSchema && def.kind === 'button' && onEditActions && <MenuItem icon={<Ic.Code size={14} />} label={t('Edit actions')} onClick={() => (onClose(), onEditActions(def))} />}
            {canSchema && !isTitle && DESCRIPTORS[def.kind].storage !== 'system' && def.kind !== 'unique_id' && <MenuItem icon={<Ic.Reset size={14} />} label={t('Change type')} onClick={() => setConvert(true)} />}
            {actions.sort && <MenuItem icon={<Ic.Up size={14} />} label={t('Sort ascending')} onClick={() => (actions.sort!('asc'), onClose())} />}
            {actions.sort && <MenuItem icon={<Ic.UpDown size={14} />} label={t('Sort descending')} onClick={() => (actions.sort!('desc'), onClose())} />}
            {actions.filter && DESCRIPTORS[def.kind].queryable && <MenuItem icon={<Ic.Search size={14} />} label={t('Filter')} onClick={() => (actions.filter!(), onClose())} />}
            {actions.freeze && <MenuItem icon={<Ic.Sidebar size={14} />} label={t('Freeze up to here')} onClick={() => (actions.freeze!(), onClose())} />}
            {actions.hide && !isTitle && <MenuItem icon={<Ic.Eye size={14} />} label={t('Hide in view')} onClick={() => (actions.hide!(), onClose())} />}
            {canSchema && !isTitle && <MenuSep />}
            {canSchema && !isTitle && <MenuItem icon={<Ic.Trash size={14} />} label={t('Delete property')} danger onClick={() => void del()} />}
          </div>
        ) : (
          <div className="db-form">
            <div className="db-form-head"><button type="button" className="icon-btn" aria-label={t('Back')} onClick={() => setView('menu')}><span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}><Ic.Chevron size={14} /></span></button><b>{def.name}</b></div>
            <MenuLabel>{t('Settings')}</MenuLabel>
            <ConfigForm svc={svc} kind={def.kind} sourceId={def.sourceId} selfId={def.id} config={config} onChange={setConfig} />
            {err && <div className="db-err" role="alert">{err}</div>}
            <div className="db-date-foot"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary" onClick={() => void save()}>{t('Save')}</button></div>
          </div>
        )}
      </div>
    </Popover>
  )
}

export { Chip, staticType }
