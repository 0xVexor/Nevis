// Filter / sort / group editors. They edit plain data (View.filter, View.sorts, configuration.group) and know nothing about storage.
import type { Definition, Filter, Id, Json, Sort } from '../model/types.ts'
import { RELATIVE_KINDS } from '../dates.ts'
import { optionsOf, statusConfig } from '../props/config.ts'
import { OPS, DESCRIPTORS } from '../props/registry.ts'
import { filterClass, isSortable } from '../query/engine.ts'
import type { DatabaseService } from '../service.ts'
import { Select } from '../../ui'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { KindIcon } from './common'

const OP_LABEL: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with', is_empty: 'is empty', is_not_empty: 'is not empty',
  gt: 'greater than', gte: 'greater or equal', lt: 'less than', lte: 'less or equal', before: 'is before', after: 'is after', on_or_before: 'is on or before', on_or_after: 'is on or after',
  between: 'is between', relative: 'is within', contains_any: 'contains any of', contains_all: 'contains all of', group_equals: 'is in group', verifier: 'verified by', expired: 'expired',
}
const REL_LABEL: Record<string, string> = {
  today: 'Today', yesterday: 'Yesterday', tomorrow: 'Tomorrow', this_week: 'This week (calendar)', last_week: 'Last week (calendar)', next_calendar_week: 'Next week (calendar)',
  past_week: 'Past 7 days', next_week: 'Next 7 days', this_month: 'This month', last_month: 'Last month', next_month: 'Next month', past_month: 'Past month', next_30_days: 'Next 30 days',
  this_year: 'This year', past_n_days: 'Past N days', next_n_days: 'Next N days',
}

export function filterableProps(svc: DatabaseService, sourceId: Id): Definition[] {
  return svc.state.props(sourceId).filter((p) => DESCRIPTORS[p.kind].queryable && filterClass(svc.state, p) !== 'derived' && filterClass(svc.state, p) !== 'none' && svc.access().canReadProperty(svc.principalId, p))
}

const defaultOperand = (svc: DatabaseService, def: Definition, op: string): Json => {
  const cls = filterClass(svc.state, def)
  if (op === 'is_empty' || op === 'is_not_empty') return null
  switch (cls) {
    case 'number': return 0
    case 'checkbox': return true
    case 'select': return optionsOf(def)[0]?.id ?? ''
    case 'status': return op === 'group_equals' ? statusConfig(def.config).groups[0].id : (optionsOf(def)[0]?.id ?? '')
    case 'members': return op === 'contains_any' || op === 'contains_all' ? [] : ''
    case 'date': return op === 'relative' ? { kind: 'today' } : op === 'between' ? { start: '', end: '' } : ''
    default: return ''
  }
}

function Operand({ svc, def, op, value, onChange }: { svc: DatabaseService; def: Definition; op: string; value: Json | undefined; onChange: (v: Json) => void }) {
  const cls = filterClass(svc.state, def)
  if (op === 'is_empty' || op === 'is_not_empty') return null
  if (cls === 'number') return <input className="db-input sm" type="number" dir="ltr" value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
  if (cls === 'checkbox') return <Select value={String(value ?? true)} options={[{ value: 'true', label: t('Checked') }, { value: 'false', label: t('Unchecked') }]} onChange={(v) => onChange(v === 'true')} />
  if (cls === 'select' || cls === 'status') {
    if (op === 'group_equals') return <Select value={String(value ?? '')} options={statusConfig(def.config).groups.map((g) => ({ value: g.id, label: g.label }))} onChange={onChange} />
    return <Select value={String(value ?? '')} options={optionsOf(def).map((o) => ({ value: o.id, label: o.name }))} onChange={onChange} />
  }
  if (cls === 'members') {
    const many = op === 'contains_any' || op === 'contains_all'
    const options = def.kind === 'multi_select' ? optionsOf(def).map((o) => ({ value: o.id, label: o.name }))
      : def.kind === 'people' || def.kind === 'created_by' || def.kind === 'last_edited_by' ? svc.state.live('principal').map((p) => ({ value: p.id, label: p.displayName }))
      : (() => {
          const rel = svc.state.relationOf(def.id)
          const target = rel ? (rel.propertyId === def.id ? rel.targetSourceId : rel.sourceId) : null
          return target ? svc.state.rows(target).slice(0, 200).map((r) => ({ value: r.page.id, label: r.page.title || t('Untitled') })) : []
        })()
    if (many) {
      const sel = (value as string[]) ?? []
      return <div className="db-chips-row">{options.map((o) => <button key={o.value} type="button" className={'db-chip pick' + (sel.includes(o.value) ? ' on' : '')} onClick={() => onChange(sel.includes(o.value) ? sel.filter((x) => x !== o.value) : [...sel, o.value])}>{o.label}</button>)}</div>
    }
    return <Select value={String(value ?? '')} options={[{ value: '', label: t('Choose…') }, ...options]} onChange={onChange} />
  }
  if (cls === 'date') {
    if (op === 'relative') {
      const v = (value as { kind: string; n?: number }) ?? { kind: 'today' }
      return (
        <>
          <Select value={v.kind} options={RELATIVE_KINDS.map((k) => ({ value: k, label: t(REL_LABEL[k]) }))} onChange={(k) => onChange({ kind: k, ...(k.endsWith('_n_days') ? { n: v.n ?? 7 } : {}) })} />
          {v.kind.endsWith('_n_days') && <input className="db-input sm" type="number" min={1} dir="ltr" value={v.n ?? 7} onChange={(e) => onChange({ kind: v.kind, n: Math.max(1, Number(e.target.value) || 1) })} />}
        </>
      )
    }
    if (op === 'between') {
      const v = (value as { start: string; end: string }) ?? { start: '', end: '' }
      return <><input className="db-input sm" type="date" dir="ltr" value={v.start} onChange={(e) => onChange({ ...v, start: e.target.value })} /><input className="db-input sm" type="date" dir="ltr" value={v.end} onChange={(e) => onChange({ ...v, end: e.target.value })} /></>
    }
    return <input className="db-input sm" type="date" dir="ltr" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
  }
  return <input className="db-input sm" dir="auto" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
}

const MAX_DEPTH = 3

function Group({ svc, sourceId, f, onChange, onRemove, depth }: { svc: DatabaseService; sourceId: Id; f: Extract<Filter, { kind: 'and' | 'or' }>; onChange: (f: Filter) => void; onRemove?: () => void; depth: number }) {
  const props = filterableProps(svc, sourceId)
  const addRule = () => {
    const p = props[0]
    if (!p) return
    const op = OPS[filterClass(svc.state, p)][0]
    onChange({ ...f, children: [...f.children, { kind: 'predicate', propertyId: p.id, op, operand: defaultOperand(svc, p, op) }] })
  }
  return (
    <div className={'db-fgroup depth' + depth}>
      <div className="db-frow head">
        <Select value={f.kind} options={[{ value: 'and', label: t('All of these (AND)') }, { value: 'or', label: t('Any of these (OR)') }]} onChange={(k) => onChange({ ...f, kind: k as 'and' | 'or' })} />
        {onRemove && <button type="button" className="icon-btn" aria-label={t('Remove group')} onClick={onRemove}><Ic.Trash size={13} /></button>}
      </div>
      {f.children.map((c, i) => {
        const setChild = (n: Filter) => onChange({ ...f, children: f.children.map((x, j) => (j === i ? n : x)) })
        const remove = () => onChange({ ...f, children: f.children.filter((_, j) => j !== i) })
        if (c.kind !== 'predicate') return <Group key={i} svc={svc} sourceId={sourceId} f={c} onChange={setChild} onRemove={remove} depth={depth + 1} />
        const def = svc.state.prop(c.propertyId)
        const ops = def ? OPS[filterClass(svc.state, def)] : []
        return (
          <div className="db-frow" key={i}>
            <Select value={c.propertyId} options={props.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => { const d = svc.state.prop(id)!; const op = OPS[filterClass(svc.state, d)][0]; setChild({ kind: 'predicate', propertyId: id, op, operand: defaultOperand(svc, d, op) }) }} />
            <Select value={c.op} options={ops.map((o) => ({ value: o, label: t(OP_LABEL[o] ?? o) }))} onChange={(op) => setChild({ ...c, op, operand: defaultOperand(svc, def!, op) })} />
            {def && <Operand svc={svc} def={def} op={c.op} value={c.operand} onChange={(v) => setChild({ ...c, operand: v })} />}
            <button type="button" className="icon-btn" aria-label={t('Remove rule')} onClick={remove}><Ic.Close size={13} /></button>
          </div>
        )
      })}
      <div className="db-frow">
        <button type="button" className="db-linkbtn" onClick={addRule}><Ic.Plus size={12} /> {t('Add a rule')}</button>
        {depth < MAX_DEPTH && <button type="button" className="db-linkbtn" onClick={() => onChange({ ...f, children: [...f.children, { kind: 'and', children: [] }] })}><Ic.Plus size={12} /> {t('Add a group')}</button>}
      </div>
    </div>
  )
}

export function FilterEditor({ svc, sourceId, filter, onChange }: { svc: DatabaseService; sourceId: Id; filter: Filter | null; onChange: (f: Filter | null) => void }) {
  const root: Extract<Filter, { kind: 'and' | 'or' }> = filter ? (filter.kind === 'predicate' ? { kind: 'and', children: [filter] } : filter) : { kind: 'and', children: [] }
  return (
    <div className="db-filter">
      <Group svc={svc} sourceId={sourceId} f={root} onChange={(f) => onChange(f.kind !== 'predicate' && f.children.length ? f : null)} depth={1} />
      {filter && <button type="button" className="db-linkbtn danger" onClick={() => onChange(null)}>{t('Clear all filters')}</button>}
      <div className="db-date-hint">{t('Hiding a property or filtering it is not a permission: anyone who can open this database can still read it.')}</div>
    </div>
  )
}

export function SortEditor({ svc, sourceId, sorts, onChange }: { svc: DatabaseService; sourceId: Id; sorts: Sort[]; onChange: (s: Sort[]) => void }) {
  const props = svc.state.props(sourceId).filter((p) => isSortable(svc.state, p) && svc.access().canReadProperty(svc.principalId, p))
  return (
    <div className="db-filter">
      {sorts.map((s, i) => (
        <div className="db-frow" key={i}>
          <Select value={s.propertyId} options={props.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => onChange(sorts.map((x, j) => (j === i ? { ...x, propertyId: id } : x)))} />
          <Select value={s.direction} options={[{ value: 'asc', label: t('Ascending') }, { value: 'desc', label: t('Descending') }]} onChange={(d) => onChange(sorts.map((x, j) => (j === i ? { ...x, direction: d as 'asc' | 'desc' } : x)))} />
          <button type="button" className="icon-btn" aria-label={t('Move up')} disabled={i === 0} onClick={() => { const n = [...sorts]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n) }}><Ic.Up size={13} /></button>
          <button type="button" className="icon-btn" aria-label={t('Remove sort')} onClick={() => onChange(sorts.filter((_, j) => j !== i))}><Ic.Close size={13} /></button>
        </div>
      ))}
      <button type="button" className="db-linkbtn" onClick={() => props[0] && onChange([...sorts, { propertyId: (props.find((p) => !sorts.some((s) => s.propertyId === p.id)) ?? props[0]).id, direction: 'asc' }])}><Ic.Plus size={12} /> {t('Add a sort')}</button>
      {sorts.length > 0 && <button type="button" className="db-linkbtn danger" onClick={() => onChange([])}>{t('Remove all sorts')}</button>}
      <div className="db-date-hint">{t('Empty values always come last. Dragging rows by hand needs the sort removed.')}</div>
    </div>
  )
}

export type GroupConfig = { propertyId: Id; mode?: string; hidden?: Id[]; order?: Id[]; collapsed?: Id[] } | null

export function GroupEditor({ svc, sourceId, group, onChange, allowNone = true }: { svc: DatabaseService; sourceId: Id; group: GroupConfig; onChange: (g: GroupConfig) => void; allowNone?: boolean }) {
  const props = svc.state.props(sourceId).filter((p) => !['button', 'files', 'connected'].includes(p.kind) && svc.access().canReadProperty(svc.principalId, p))
  const def = group ? svc.state.prop(group.propertyId) : undefined
  const modes: { value: string; label: string }[] = !def ? [] : def.kind === 'status' ? [{ value: 'option', label: t('By status') }, { value: 'status_group', label: t('By group') }]
    : def.kind === 'date' || def.kind === 'created_time' || def.kind === 'last_edited_time' ? [{ value: 'day', label: t('Day') }, { value: 'week', label: t('Week') }, { value: 'month', label: t('Month') }, { value: 'year', label: t('Year') }, { value: 'relative', label: t('Relative') }]
    : def.kind === 'text' || def.kind === 'title' ? [{ value: 'exact', label: t('Exact') }, { value: 'prefix', label: t('First letter') }]
    : []
  return (
    <div className="db-filter">
      <div className="db-frow">
        <Select value={group?.propertyId ?? ''} options={[...(allowNone ? [{ value: '', label: t('No grouping') }] : []), ...props.map((p) => ({ value: p.id, label: p.name }))]} onChange={(id) => onChange(id ? { propertyId: id } : null)} />
        {modes.length > 0 && <Select value={group?.mode ?? modes[0].value} options={modes} onChange={(m) => onChange({ ...group!, mode: m })} />}
      </div>
    </div>
  )
}

export const PropBadge = ({ def }: { def: Definition }) => <span className="db-pb"><KindIcon kind={def.kind} /> {def.name}</span>
