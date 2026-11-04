// Filter / sort / group editors. They edit plain data (View.filter, View.sorts, configuration.group) and know nothing about storage.
import type { Definition, Filter, Id, Json, Sort } from '../model/types.ts'
import { RELATIVE_KINDS } from '../dates.ts'
import { optionsOf, statusConfig } from '../props/config.ts'
import { OPS, DESCRIPTORS } from '../props/registry.ts'
import { filterClass, isSortable } from '../query/engine.ts'
import type { DatabaseService } from '../service.ts'
import { Button, ChipButton, Dropdown, FormField, Icon, IconButton, Segmented } from '../../design-system'
import { t } from '../../i18n'
import { Hint, optionColor, rawOptions } from './common'

const OP_LABEL: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  between: 'is between',
  relative: 'is within',
  contains_any: 'contains any of',
  contains_all: 'contains all of',
  group_equals: 'is in group',
  verifier: 'verified by',
  expired: 'expired',
}
const REL_LABEL: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  tomorrow: 'Tomorrow',
  this_week: 'This week (calendar)',
  last_week: 'Last week (calendar)',
  next_calendar_week: 'Next week (calendar)',
  past_week: 'Past 7 days',
  next_week: 'Next 7 days',
  this_month: 'This month',
  last_month: 'Last month',
  next_month: 'Next month',
  past_month: 'Past month',
  next_30_days: 'Next 30 days',
  this_year: 'This year',
  past_n_days: 'Past N days',
  next_n_days: 'Next N days',
}

export function filterableProps(svc: DatabaseService, sourceId: Id): Definition[] {
  return svc.state
    .props(sourceId)
    .filter((p) => DESCRIPTORS[p.kind].queryable && filterClass(svc.state, p) !== 'derived' && filterClass(svc.state, p) !== 'none' && svc.access().canReadProperty(svc.principalId, p))
}

const defaultOperand = (svc: DatabaseService, def: Definition, op: string): Json => {
  const cls = filterClass(svc.state, def)
  if (op === 'is_empty' || op === 'is_not_empty') return null
  switch (cls) {
    case 'number':
      return 0
    case 'checkbox':
      return true
    case 'select':
      return optionsOf(def)[0]?.id ?? ''
    case 'status':
      return op === 'group_equals' ? statusConfig(def.config).groups[0].id : (optionsOf(def)[0]?.id ?? '')
    case 'members':
      return op === 'contains_any' || op === 'contains_all' ? [] : ''
    case 'date':
      return op === 'relative' ? { kind: 'today' } : op === 'between' ? { start: '', end: '' } : ''
    default:
      return ''
  }
}

/** The things a members filter can pick from: options, people or the items of the related source. */
function memberChoices(svc: DatabaseService, def: Definition): { value: string; label: string; raw: boolean }[] {
  if (def.kind === 'multi_select') return optionsOf(def).map((o) => ({ value: o.id, label: o.name, raw: true }))
  if (def.kind === 'people' || def.kind === 'created_by' || def.kind === 'last_edited_by') return svc.state.live('principal').map((p) => ({ value: p.id, label: p.displayName, raw: true }))
  const rel = svc.state.relationOf(def.id)
  const target = rel ? (rel.propertyId === def.id ? rel.targetSourceId : rel.sourceId) : null
  return target
    ? svc.state
        .rows(target)
        .slice(0, 200)
        .map((r) => ({ value: r.page.id, label: r.page.title || t('Untitled'), raw: true }))
    : []
}

export function FilterOperand({ svc, def, op, value, onChange }: { svc: DatabaseService; def: Definition; op: string; value: Json | undefined; onChange: (v: Json) => void }) {
  const cls = filterClass(svc.state, def)
  if (op === 'is_empty' || op === 'is_not_empty') return null
  if (cls === 'number')
    return <input className="ds-field dv-operand" type="number" dir="ltr" aria-label={t('Value')} value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
  if (cls === 'checkbox')
    return (
      <Dropdown
        className="ds-dd-btn--sm"
        label={t('Value')}
        value={String(value ?? true)}
        options={[
          { value: 'true', label: 'Checked' },
          { value: 'false', label: 'Unchecked' },
        ]}
        onChange={(v) => onChange(v === 'true')}
      />
    )
  if (cls === 'select' || cls === 'status') {
    if (op === 'group_equals')
      return <Dropdown className="ds-dd-btn--sm" label={t('Value')} value={String(value ?? '')} options={statusConfig(def.config).groups.map((g) => ({ value: g.id, label: g.label, raw: true }))} onChange={onChange} />
    return (
      <Dropdown
        className="ds-dd-btn--sm"
        label={t('Value')}
        placeholder={t('Choose…')}
        value={String(value ?? '')}
        options={optionsOf(def).map((o) => ({ value: o.id, label: o.name, raw: true, swatch: optionColor(o.color) }))}
        onChange={onChange}
      />
    )
  }
  if (cls === 'members') {
    const options = memberChoices(svc, def)
    if (op === 'contains_any' || op === 'contains_all') {
      const sel = (value as string[]) ?? []
      return (
        <div className="dv-operand-chips" role="group" aria-label={t('Value')}>
          {options.map((o) => (
            <ChipButton key={o.value} aria-pressed={sel.includes(o.value)} onClick={() => onChange(sel.includes(o.value) ? sel.filter((x) => x !== o.value) : [...sel, o.value])}>
              <span dir="auto">{o.label}</span>
            </ChipButton>
          ))}
        </div>
      )
    }
    return <Dropdown className="ds-dd-btn--sm" label={t('Value')} placeholder={t('Choose…')} value={String(value ?? '')} options={options} onChange={onChange} />
  }
  if (cls === 'date') {
    if (op === 'relative') {
      const v = (value as { kind: string; n?: number }) ?? { kind: 'today' }
      return (
        <>
          <Dropdown
            className="ds-dd-btn--sm"
            label={t('Value')}
            value={v.kind}
            options={RELATIVE_KINDS.map((k) => ({ value: k, label: REL_LABEL[k] }))}
            onChange={(k) => onChange({ kind: k, ...(k.endsWith('_n_days') ? { n: v.n ?? 7 } : {}) })}
          />
          {v.kind.endsWith('_n_days') && (
            <input
              className="ds-field dv-operand dv-operand--short"
              type="number"
              min={1}
              dir="ltr"
              aria-label={t('Days')}
              value={v.n ?? 7}
              onChange={(e) => onChange({ kind: v.kind, n: Math.max(1, Number(e.target.value) || 1) })}
            />
          )}
        </>
      )
    }
    if (op === 'between') {
      const v = (value as { start: string; end: string }) ?? { start: '', end: '' }
      return (
        <>
          <input className="ds-field dv-operand" type="date" dir="ltr" aria-label={t('From')} value={v.start} onChange={(e) => onChange({ ...v, start: e.target.value })} />
          <input className="ds-field dv-operand" type="date" dir="ltr" aria-label={t('To')} value={v.end} onChange={(e) => onChange({ ...v, end: e.target.value })} />
        </>
      )
    }
    return <input className="ds-field dv-operand" type="date" dir="ltr" aria-label={t('Value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
  }
  return <input className="ds-field dv-operand" dir="auto" aria-label={t('Value')} placeholder={t('Value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
}

const MAX_DEPTH = 3

function Group({
  svc,
  sourceId,
  f,
  onChange,
  onRemove,
  depth,
}: {
  svc: DatabaseService
  sourceId: Id
  f: Extract<Filter, { kind: 'and' | 'or' }>
  onChange: (f: Filter) => void
  onRemove?: () => void
  depth: number
}) {
  const props = filterableProps(svc, sourceId)
  const addRule = () => {
    const p = props[0]
    if (!p) return
    const op = OPS[filterClass(svc.state, p)][0]
    onChange({ ...f, children: [...f.children, { kind: 'predicate', propertyId: p.id, op, operand: defaultOperand(svc, p, op) }] })
  }
  return (
    <div className="dv-fgroup" data-depth={depth}>
      {(f.children.length > 1 || depth > 1) && (
        <div className="dv-fgroup-head">
          <Segmented
            label={t('Match')}
            value={f.kind}
            options={[
              { value: 'and', label: t('All of these') },
              { value: 'or', label: t('Any of these') },
            ]}
            onChange={(k) => onChange({ ...f, kind: k })}
          />
          {onRemove && (
            <IconButton label={t('Remove group')} onClick={onRemove}>
              <Icon name="trash" size={15} />
            </IconButton>
          )}
        </div>
      )}
      {f.children.map((c, i) => {
        const setChild = (n: Filter) => onChange({ ...f, children: f.children.map((x, j) => (j === i ? n : x)) })
        const remove = () => onChange({ ...f, children: f.children.filter((_, j) => j !== i) })
        if (c.kind !== 'predicate') return <Group key={i} svc={svc} sourceId={sourceId} f={c} onChange={setChild} onRemove={remove} depth={depth + 1} />
        const def = svc.state.prop(c.propertyId)
        const ops = def ? OPS[filterClass(svc.state, def)] : []
        return (
          <div className="dv-rule" key={i}>
            <span className="dv-rule-join">{i === 0 ? t('Where') : f.kind === 'and' ? t('and') : t('or')}</span>
            <Dropdown
              className="ds-dd-btn--sm"
              label={t('Property')}
              value={c.propertyId}
              options={rawOptions(props)}
              onChange={(id) => {
                const d = svc.state.prop(id)!
                const op = OPS[filterClass(svc.state, d)][0]
                setChild({ kind: 'predicate', propertyId: id, op, operand: defaultOperand(svc, d, op) })
              }}
            />
            <Dropdown className="ds-dd-btn--sm" label={t('Condition')} value={c.op} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] ?? o }))} onChange={(op) => setChild({ ...c, op, operand: defaultOperand(svc, def!, op) })} />
            {def && <FilterOperand svc={svc} def={def} op={c.op} value={c.operand} onChange={(v) => setChild({ ...c, operand: v })} />}
            <IconButton className="dv-rule-x" label={t('Remove rule')} onClick={remove}>
              <Icon name="x" size={15} />
            </IconButton>
          </div>
        )
      })}
      <div className="dv-rule-adds">
        <Button size="sm" variant="ghost" icon={<Icon name="plus" size={15} />} onClick={addRule} disabled={!props.length}>
          {t('Add a rule')}
        </Button>
        {depth < MAX_DEPTH && (
          <Button size="sm" variant="ghost" icon={<Icon name="plus" size={15} />} onClick={() => onChange({ ...f, children: [...f.children, { kind: 'and', children: [] }] })}>
            {t('Add a group')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function FilterEditor({ svc, sourceId, filter, onChange }: { svc: DatabaseService; sourceId: Id; filter: Filter | null; onChange: (f: Filter | null) => void }) {
  const root: Extract<Filter, { kind: 'and' | 'or' }> = filter ? (filter.kind === 'predicate' ? { kind: 'and', children: [filter] } : filter) : { kind: 'and', children: [] }
  return (
    <div className="dv-filter">
      {root.children.length === 0 && <Hint>{t('No filters. Every item is shown.')}</Hint>}
      <Group svc={svc} sourceId={sourceId} f={root} onChange={(f) => onChange(f.kind !== 'predicate' && f.children.length ? f : null)} depth={1} />
      <Hint>{t('Hiding a property or filtering it is not a permission: anyone who can open this database can still read it.')}</Hint>
    </div>
  )
}

export function SortEditor({ svc, sourceId, sorts, onChange }: { svc: DatabaseService; sourceId: Id; sorts: Sort[]; onChange: (s: Sort[]) => void }) {
  const props = svc.state.props(sourceId).filter((p) => isSortable(svc.state, p) && svc.access().canReadProperty(svc.principalId, p))
  return (
    <div className="dv-filter">
      {sorts.length === 0 && <Hint>{t('No sorts. Items keep the order you give them.')}</Hint>}
      {sorts.map((s, i) => (
        <div className="dv-rule" key={i}>
          <span className="dv-rule-join">{i === 0 ? t('Sort by') : t('then')}</span>
          <Dropdown className="ds-dd-btn--sm" label={t('Property')} value={s.propertyId} options={rawOptions(props)} onChange={(id) => onChange(sorts.map((x, j) => (j === i ? { ...x, propertyId: id } : x)))} />
          <Segmented
            label={t('Direction')}
            value={s.direction}
            options={[
              { value: 'asc', label: t('Ascending') },
              { value: 'desc', label: t('Descending') },
            ]}
            onChange={(d) => onChange(sorts.map((x, j) => (j === i ? { ...x, direction: d } : x)))}
          />
          <span className="dv-rule-tools">
            <IconButton
              label={t('Move up')}
              disabled={i === 0}
              onClick={() => {
                const n = [...sorts]
                ;[n[i - 1], n[i]] = [n[i], n[i - 1]]
                onChange(n)
              }}
            >
              <Icon name="arrow-up" size={15} />
            </IconButton>
            <IconButton label={t('Remove sort')} onClick={() => onChange(sorts.filter((_, j) => j !== i))}>
              <Icon name="x" size={15} />
            </IconButton>
          </span>
        </div>
      ))}
      <div className="dv-rule-adds">
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="plus" size={15} />}
          disabled={!props.length}
          onClick={() => onChange([...sorts, { propertyId: (props.find((p) => !sorts.some((s) => s.propertyId === p.id)) ?? props[0]).id, direction: 'asc' }])}
        >
          {t('Add a sort')}
        </Button>
      </div>
      <Hint>{t('Empty values always come last. Dragging rows by hand needs the sort removed.')}</Hint>
    </div>
  )
}

export type GroupConfig = { propertyId: Id; mode?: string; hidden?: Id[]; order?: Id[]; collapsed?: Id[] } | null

export function groupModes(def: Definition | undefined): { value: string; label: string }[] {
  if (!def) return []
  if (def.kind === 'status')
    return [
      { value: 'option', label: t('By status') },
      { value: 'status_group', label: t('By group') },
    ]
  if (def.kind === 'date' || def.kind === 'created_time' || def.kind === 'last_edited_time')
    return [
      { value: 'day', label: t('Day') },
      { value: 'week', label: t('Week') },
      { value: 'month', label: t('Month') },
      { value: 'year', label: t('Year') },
      { value: 'relative', label: t('Relative') },
    ]
  if (def.kind === 'text' || def.kind === 'title')
    return [
      { value: 'exact', label: t('Exact') },
      { value: 'prefix', label: t('First letter') },
    ]
  return []
}

export function GroupEditor({ svc, sourceId, group, onChange, allowNone = true }: { svc: DatabaseService; sourceId: Id; group: GroupConfig; onChange: (g: GroupConfig) => void; allowNone?: boolean }) {
  const props = svc.state.props(sourceId).filter((p) => !['button', 'files', 'connected'].includes(p.kind) && svc.access().canReadProperty(svc.principalId, p))
  const def = group ? svc.state.prop(group.propertyId) : undefined
  const modes = groupModes(def)
  return (
    <div className="dv-filter">
      <FormField label={t('Group by')}>
        <Dropdown
          label={t('Group by')}
          value={group?.propertyId ?? ''}
          options={[...(allowNone ? [{ value: '', label: 'No grouping' }] : []), ...rawOptions(props)]}
          onChange={(id) => onChange(id ? { propertyId: id } : null)}
        />
      </FormField>
      {modes.length > 0 && <Segmented label={t('Group by')} value={group?.mode ?? modes[0].value} options={modes} onChange={(m) => onChange({ ...group!, mode: m })} />}
    </div>
  )
}

/** One line per rule for the summary under the toolbar: "Status is Done". */
export function describeFilter(svc: DatabaseService, f: Filter | null): string[] {
  if (!f) return []
  if (f.kind !== 'predicate') {
    if (f.children.every((c) => c.kind === 'predicate') && f.kind === 'and') return f.children.flatMap((c) => describeFilter(svc, c))
    return [t('{n} rules', { n: countRules(f) })]
  }
  const def = svc.state.prop(f.propertyId)
  if (!def) return [t('Deleted property')]
  const op = t(OP_LABEL[f.op] ?? f.op)
  const v = f.operand
  let text = ''
  if (typeof v === 'string' && v) text = optionsOf(def).find((o) => o.id === v)?.name ?? svc.state.pages.get(v)?.title ?? svc.state.get('principal', v)?.displayName ?? v
  else if (typeof v === 'number') text = String(v)
  else if (typeof v === 'boolean') text = v ? t('Checked') : t('Unchecked')
  else if (Array.isArray(v)) text = t('{n} chosen', { n: v.length })
  else if (v && typeof v === 'object' && 'kind' in v) text = t(REL_LABEL[(v as { kind: string }).kind] ?? '')
  return [`${def.name} ${op}${text ? ' ' + text : ''}`]
}
const countRules = (f: Filter): number => (f.kind === 'predicate' ? 1 : f.children.reduce((n, c) => n + countRules(c), 0))
export const filterRuleCount = (f: Filter | null) => (f ? countRules(f) : 0)

export { defaultOperand as defaultFilterOperand }
export const filterOperatorLabel = (op: string) => t(OP_LABEL[op] ?? op)
