// Property schema UI: the type picker, per-kind settings, option manager, formula editor, conversion dialog and the column menu.
import { useMemo, useState } from 'react'
import type { Definition, Id, Json, Kind } from '../model/types.ts'
import { compileFormula } from '../formula/compile.ts'
import { registryTable } from '../formula/functions.ts'
import { previewConversion, type ConvertPlan, type ConversionReport } from '../commands/convert.ts'
import { optionsOf, ROLLUP_AGGREGATIONS, statusConfig, type OptionColor, type RollupAggregation } from '../props/config.ts'
import { CURRENCIES } from '../props/numberFormat.ts'
import { DESCRIPTORS } from '../props/registry.ts'
import { schemaFor, staticType } from '../resolver.ts'
import type { DatabaseService } from '../service.ts'
import { confirmDialog, promptDialog } from '../../dialog'
import { Button, Checkbox, ChipButton, Dialog, Dropdown, Field, FormField, Icon, IconButton, Panel, Popover, Segmented, SwitchRow, useMenu, type MenuItem } from '../../design-system'
import { t } from '../../i18n'
import { Chip, COLOR_LABEL, ErrorLine, Hint, KIND_GROUPS, KIND_LABEL, KindIcon, OPTION_COLOR_LIST, errorText, optionColor, rawOptions } from './common'

// ───── options manager ─────

export function OptionsManager({ svc, def }: { svc: DatabaseService; def: Definition }) {
  const opts = optionsOf(def)
  const groups = def.kind === 'status' ? statusConfig(def.config).groups : []
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const { open, menu } = useMenu()
  const run = async (cmds: { type: string; payload: Json }[]) => {
    const r = await svc.tryExec(cmds)
    setErr(r.ok ? null : errorText(r.code, r.message))
    return r.ok
  }
  const add = async () => {
    if (!adding.trim()) return
    if (await run([{ type: 'option.upsert', payload: { propertyId: def.id, name: adding.trim(), color: 'default', ...(def.kind === 'status' ? { statusGroupId: groups[0].id } : {}) } }])) setAdding('')
  }
  const del = async (o: { id: Id; name: string }) => {
    let replacement: Id | undefined
    const cfg = def.kind === 'status' ? statusConfig(def.config) : null
    const used = svc.state.rows(def.sourceId).some((r) => {
      const c = r.ext.cells[def.id]?.value
      return c && (c.kind === 'status' || c.kind === 'select' ? c.optionId === o.id : c.kind === 'multi_select' && c.optionIds.includes(o.id))
    })
    if (cfg && (cfg.defaultOptionId === o.id || used)) {
      const others = cfg.options.filter((x) => x.id !== o.id)
      if (!others.length) return setErr(t('A status needs at least one option.'))
      const name = await promptDialog({
        title: t('Replace “{n}” with…', { n: o.name }),
        message: t('Type the name of an existing option: items using “{n}” move to it.', { n: o.name }),
        initial: others[0].name,
      })
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
  const colors = (o: { id: Id; name: string; color: OptionColor }): MenuItem[] =>
    OPTION_COLOR_LIST.map((c) => ({ label: COLOR_LABEL[c], swatch: optionColor(c), checked: o.color === c, onSelect: () => void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: o.id, name: o.name, color: c } }]) }))
  return (
    <div className="dv-options">
      {opts.map((o, i) => (
        <div className="dv-option" key={o.id}>
          <button type="button" className="dv-swatch" style={{ background: optionColor(o.color) }} aria-label={t('Colour of {n}', { n: o.name })} onClick={(e) => open(colors(o), e.currentTarget)} />
          <input
            className="ds-field dv-option-name"
            defaultValue={o.name}
            dir="auto"
            aria-label={t('Option name')}
            onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: o.id, name: e.target.value.trim() } }])}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          />
          {def.kind === 'status' && (
            <Dropdown
              className="ds-dd-btn--sm"
              label={t('Group')}
              value={(o as unknown as { statusGroupId: Id }).statusGroupId}
              options={groups.map((g) => ({ value: g.id, label: g.label, raw: true }))}
              onChange={(g) => void run([{ type: 'option.upsert', payload: { propertyId: def.id, optionId: o.id, name: o.name, statusGroupId: g } }])}
            />
          )}
          <IconButton label={t('Move up')} disabled={i === 0} onClick={() => void move(o.id, -1)}>
            <Icon name="arrow-up" size={15} />
          </IconButton>
          <IconButton label={t('Move down')} disabled={i === opts.length - 1} onClick={() => void move(o.id, 1)}>
            <Icon name="arrow-down" size={15} />
          </IconButton>
          <IconButton label={t('Delete option')} onClick={() => void del(o)}>
            <Icon name="trash" size={15} />
          </IconButton>
        </div>
      ))}
      <div className="dv-option">
        <input
          className="ds-field dv-option-name"
          placeholder={t('Add an option…')}
          aria-label={t('Add an option…')}
          value={adding}
          dir="auto"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void add()}
        />
        <Button size="sm" onClick={() => void add()} disabled={!adding.trim()}>
          {t('Add')}
        </Button>
      </div>
      {err && <ErrorLine>{err}</ErrorLine>}
      {menu}
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
    <div className="dv-formula">
      <textarea className="ds-field dv-code" dir="ltr" rows={4} spellCheck={false} aria-label={t('Formula')} value={source} onChange={(e) => onChange(e.target.value)} placeholder={'prop("Price") * 2'} />
      {source.trim() &&
        !result.ok &&
        result.diagnostics.map((d, i) => (
          <ErrorLine key={i}>
            <span dir="ltr">
              {d.code}: {d.message} ({d.from}–{d.to})
            </span>
          </ErrorLine>
        ))}
      {source.trim() && result.ok && (
        <p className="dv-ok">
          <Icon name="check" size={14} /> {t('Result type')}: <span dir="ltr">{result.resultType}</span>
        </p>
      )}
      <div className="dv-chips" aria-label={t('Insert property')}>
        {props.map((p) => (
          <ChipButton key={p.id} icon={<KindIcon kind={p.kind} size={14} />} onClick={() => insert(`prop(${JSON.stringify(p.name)})`)} title={t('Insert property')}>
            <span dir="auto">{p.name}</span>
          </ChipButton>
        ))}
      </div>
      <Button size="sm" variant="ghost" aria-expanded={help} onClick={() => setHelp(!help)}>
        {help ? t('Hide functions') : t('Show functions')}
      </Button>
      {help && (
        <div className="dv-fns" dir="ltr">
          {fns.map((f) => (
            <button key={f.name} type="button" className="dv-fn" onClick={() => insert(`${f.name}(`)}>
              <code>
                {f.name}({f.params.join(', ')})
              </code>
              <small>{f.doc}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ───── per-kind settings ─────

type Cfg = Record<string, Json>

const CONNECTED_PROVIDERS: [string, string][] = [
  ['github_pr', 'GitHub pull request'],
  ['gdrive', 'Google Drive file'],
  ['figma', 'Figma file'],
  ['zendesk', 'Zendesk ticket'],
]
const REMINDER_CHOICES: [number, string][] = [
  [0, 'At the time'],
  [10, '10 minutes before'],
  [60, '1 hour before'],
  [1440, '1 day before'],
  [2880, '2 days before'],
]

export function ConfigForm({ svc, kind, sourceId, selfId, config, onChange }: { svc: DatabaseService; kind: Kind; sourceId: Id; selfId: Id | null; config: Cfg; onChange: (c: Cfg) => void }) {
  const set = (patch: Cfg) => onChange({ ...config, ...patch })
  const sources = svc.state.live('source').filter((s) => svc.access().sourceCaps(svc.principalId, s.id).has('read'))
  switch (kind) {
    case 'number': {
      const fmt = (config.format as string) ?? 'plain'
      const prog = config.progress as { mode: 'bar' | 'ring'; target: number; color: string } | undefined
      return (
        <>
          <FormField label={t('Format')}>
            <Segmented
              label={t('Format')}
              value={fmt}
              onChange={(v) => set({ format: v })}
              options={[
                { value: 'plain', label: t('Number') },
                { value: 'grouped', label: t('Grouped') },
                { value: 'percent', label: t('Percent') },
                { value: 'currency', label: t('Currency') },
              ]}
            />
          </FormField>
          {fmt === 'currency' && (
            <FormField label={t('Currency')}>
              <Dropdown label={t('Currency')} value={(config.currencyCode as string) ?? 'USD'} options={CURRENCIES.map((c) => ({ value: c, label: c, raw: true }))} onChange={(v) => set({ currencyCode: v })} />
            </FormField>
          )}
          <FormField label={t('Decimal places')} hint={t('Only changes how the number is shown, never the stored value.')}>
            <Field ltr type="number" min={0} max={12} value={(config.precision as number) ?? 0} onChange={(e) => set({ precision: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
          </FormField>
          <SwitchRow label={t('Show as progress')} checked={!!prog} onChange={(on) => set({ progress: on ? { mode: 'bar', target: 100, color: 'green' } : null })} />
          {prog && (
            <div className="dv-pair">
              <FormField label={t('Shape')}>
                <Segmented
                  label={t('Shape')}
                  value={prog.mode}
                  onChange={(v) => set({ progress: { ...prog, mode: v } })}
                  options={[
                    { value: 'bar', label: t('Bar') },
                    { value: 'ring', label: t('Ring') },
                  ]}
                />
              </FormField>
              <FormField label={t('Full at')}>
                <Field ltr type="number" value={prog.target} onChange={(e) => set({ progress: { ...prog, target: Number(e.target.value) || 100 } })} />
              </FormField>
            </div>
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
      return (
        <FormField label={t('Options')} hint={t('One per line. You can change them later.')}>
          <textarea
            className="ds-field"
            rows={4}
            dir="auto"
            aria-label={t('Options')}
            value={names}
            onChange={(e) =>
              set({
                optionNames: e.target.value,
                options: e.target.value
                  .split('\n')
                  .map((n) => n.trim())
                  .filter(Boolean)
                  .map((name) => ({ name })),
              })
            }
          />
        </FormField>
      )
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time': {
      const cur = ((config.reminders as { offsetMinutes: number }[]) ?? []).map((r) => r.offsetMinutes)
      return (
        <>
          <FormField label={t('Calendar')}>
            <Segmented
              label={t('Calendar')}
              value={(config.displayCalendar as string) ?? 'gregorian'}
              onChange={(v) => set({ displayCalendar: v })}
              options={[
                { value: 'gregorian', label: t('Gregorian') },
                { value: 'jalali', label: t('Jalali') },
              ]}
            />
          </FormField>
          <FormField label={t('Time')}>
            <Segmented
              label={t('Time')}
              value={(config.timeFormat as string) ?? '24h'}
              onChange={(v) => set({ timeFormat: v })}
              options={[
                { value: '24h', label: t('24 hours') },
                { value: '12h', label: t('12 hours') },
                { value: 'none', label: t('Hidden') },
              ]}
            />
          </FormField>
          {kind === 'date' && (
            <FormField label={t('Reminders')} hint={t('Shown in the app (and as a system notification if you allow it) while the app is open. Dates without a time remind relative to 09:00.')}>
              <div className="dv-checks">
                {REMINDER_CHOICES.map(([min, label]) => (
                  <Checkbox
                    key={min}
                    checked={cur.includes(min)}
                    onChange={(on) => set({ reminders: (on ? [...cur, min] : cur.filter((x) => x !== min)).sort((a, b) => a - b).map((offsetMinutes) => ({ offsetMinutes })) })}
                  >
                    {t(label)}
                  </Checkbox>
                ))}
              </div>
            </FormField>
          )}
        </>
      )
    }
    case 'people':
      return <SwitchRow label={t('Allow several people')} checked={config.multiple !== false} onChange={(v) => set({ multiple: v })} />
    case 'files':
      return (
        <FormField label={t('Allowed types')} hint={t('Comma separated, e.g. image/*, application/pdf. Empty allows everything.')}>
          <Field
            ltr
            value={((config.allowedTypes as string[]) ?? []).join(', ')}
            onChange={(e) =>
              set({
                allowedTypes: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </FormField>
      )
    case 'relation': {
      const target = (config.targetSourceId as string) ?? svc.state.get('source', sourceId)?.id
      const self = target === sourceId
      return (
        <>
          <FormField label={t('Related to')}>
            <Dropdown
              label={t('Related to')}
              value={target ?? ''}
              options={rawOptions(sources)}
              onChange={(v) => set({ targetSourceId: v, mode: v === sourceId ? (config.mode ?? 'paired') : config.mode === 'self_symmetric' ? 'one_way' : config.mode })}
            />
          </FormField>
          <FormField label={t('Direction')}>
            <Segmented
              label={t('Direction')}
              value={(config.mode as string) ?? 'one_way'}
              onChange={(v) => set({ mode: v })}
              options={[{ value: 'one_way', label: t('One way') }, { value: 'paired', label: t('Two way') }, ...(self ? [{ value: 'self_symmetric', label: t('Mutual') }] : [])]}
            />
          </FormField>
          <FormField label={t('Links per item')}>
            <Segmented
              label={t('Links per item')}
              value={(config.cardinality as string) ?? 'many'}
              onChange={(v) => set({ cardinality: v })}
              options={[
                { value: 'many', label: t('Many') },
                { value: 'one', label: t('One') },
              ]}
            />
          </FormField>
          {config.mode === 'paired' && (
            <>
              <FormField label={t('Name of the reverse property')}>
                <Field value={(config.inverseName as string) ?? ''} onChange={(e) => set({ inverseName: e.target.value })} />
              </FormField>
              <FormField label={t('Reverse links per item')}>
                <Segmented
                  label={t('Reverse links per item')}
                  value={(config.inverseCardinality as string) ?? 'many'}
                  onChange={(v) => set({ inverseCardinality: v })}
                  options={[
                    { value: 'many', label: t('Many') },
                    { value: 'one', label: t('One') },
                  ]}
                />
              </FormField>
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
      if (!rels.length) return <Hint>{t('Add a relation property first.')}</Hint>
      return (
        <>
          <FormField label={t('Relation')}>
            <Dropdown label={t('Relation')} value={relId ?? ''} options={rawOptions(rels)} onChange={(v) => set({ relationPropertyId: v, targetPropertyId: '' })} />
          </FormField>
          <FormField label={t('Property')}>
            <Dropdown label={t('Property')} placeholder={t('Choose…')} value={(config.targetPropertyId as string) ?? ''} options={rawOptions(tprops)} onChange={(v) => set({ targetPropertyId: v })} />
          </FormField>
          <FormField label={t('Calculate')}>
            <Dropdown label={t('Calculate')} value={(config.aggregation as string) ?? 'count_all'} options={(ROLLUP_AGGREGATIONS as RollupAggregation[]).map((a) => ({ value: a, label: AGG_LABEL[a] }))} onChange={(v) => set({ aggregation: v })} />
          </FormField>
        </>
      )
    }
    case 'formula':
      return <FormulaEditor svc={svc} sourceId={sourceId} selfId={selfId} source={(config.source as string) ?? ''} onChange={(s) => set({ source: s })} />
    case 'unique_id': {
      const mode = (config.allocationMode as string) ?? 'partitioned'
      return (
        <>
          <FormField label={t('Prefix')}>
            <Field ltr maxLength={12} value={(config.prefix as string) ?? ''} onChange={(e) => set({ prefix: e.target.value })} placeholder="TASK" />
          </FormField>
          <FormField
            label={t('Numbering')}
            hint={
              mode === 'sequential'
                ? t('Strictly increasing numbers (TASK-1, TASK-2…). Use this when only one device creates items, or a shared server hands out numbers.')
                : t('Each device numbers its own items (TASK-ab12-1). No two devices ever clash, even offline. Numbers are never changed later.')
            }
          >
            <Segmented
              label={t('Numbering')}
              value={mode}
              onChange={(v) => set({ allocationMode: v })}
              options={[
                { value: 'partitioned', label: t('Per device (safe offline)') },
                { value: 'sequential', label: t('Sequential') },
              ]}
            />
          </FormField>
        </>
      )
    }
    case 'button':
      return (
        <>
          <FormField label={t('Button label')}>
            <Field value={(config.label as string) ?? ''} onChange={(e) => set({ label: e.target.value })} />
          </FormField>
          <Hint>{t('After creating the button, choose what it does from its menu → Edit actions.')}</Hint>
        </>
      )
    case 'verification':
      return (
        <FormField label={t('Verification expires')}>
          <Dropdown
            label={t('Verification expires')}
            value={(config.expiryPolicy as string) ?? 'never'}
            options={['never', '7d', '30d', '90d', '180d'].map((v) => ({ value: v, label: v === 'never' ? t('Never') : t('After {n} days', { n: v.replace('d', '') }), raw: true }))}
            onChange={(v) => set({ expiryPolicy: v })}
          />
        </FormField>
      )
    case 'connected':
      return (
        <>
          <FormField label={t('Service')}>
            <Dropdown label={t('Service')} value={(config.providerId as string) ?? 'github_pr'} options={CONNECTED_PROVIDERS.map(([value, label]) => ({ value, label }))} onChange={(v) => set({ providerId: v })} />
          </FormField>
          <FormField label={t('Connection name')} hint={t('Names a connection set up on your gateway. The secret never enters your notes.')}>
            <Field ltr value={(config.connectionId as string) ?? 'default'} onChange={(e) => set({ connectionId: e.target.value.trim() || 'default' })} />
          </FormField>
        </>
      )
    case 'place':
      return <Hint>{t('Coordinates are typed by hand and work offline. Address lookup needs a map provider; nothing is looked up automatically.')}</Hint>
    default:
      return null
  }
}

const AGG_LABEL: Record<RollupAggregation, string> = {
  count_all: 'Count all',
  count_values: 'Count values',
  count_unique: 'Count unique values',
  count_empty: 'Count empty',
  count_not_empty: 'Count not empty',
  percent_empty: 'Percent empty',
  percent_not_empty: 'Percent not empty',
  checked: 'Checked',
  unchecked: 'Unchecked',
  percent_checked: 'Percent checked',
  percent_unchecked: 'Percent unchecked',
  sum: 'Sum',
  average: 'Average',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  range: 'Range',
  earliest_date: 'Earliest date',
  latest_date: 'Latest date',
  date_range: 'Date range',
  show_original: 'Show original',
  show_unique: 'Show unique',
}
export const aggLabel = (a: RollupAggregation) => t(AGG_LABEL[a])
export const aggKey = (a: RollupAggregation) => AGG_LABEL[a]

// ───── create ─────

/** Kinds whose settings must be chosen before the property can exist; the others are created with one click. */
const NEEDS_SETUP: Kind[] = ['select', 'multi_select', 'status', 'relation', 'rollup', 'formula', 'button', 'connected', 'unique_id']

export function NewPropertyPopover({
  svc,
  sourceId,
  anchor,
  onClose,
  onCreated,
  beforeId,
}: {
  svc: DatabaseService
  sourceId: Id
  anchor: DOMRect
  onClose: () => void
  onCreated?: (id: Id) => void
  beforeId?: Id
}) {
  const [kind, setKind] = useState<Kind | null>(null)
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Cfg>({})
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const create = async (k = kind, cfg0 = config, nm0 = name) => {
    if (!k) return
    const nm = nm0.trim() || t(KIND_LABEL[k])
    let cfg: Cfg = { ...cfg0 }
    if (k === 'relation') cfg = { mode: 'one_way', ...cfg, targetSourceId: cfg.targetSourceId ?? sourceId }
    const r = await svc.tryExec([{ type: 'property.create', payload: { sourceId, name: nm, kind: k, config: cfg, ...(beforeId ? { beforePropertyId: beforeId } : {}) } }])
    if (!r.ok) return setErr(errorText(r.code, r.message))
    const res = r.result as { propertyId?: Id }
    if (k === 'button') {
      // a button needs its workflow record; actions are edited from the column menu
      await svc.tryExec([{ type: 'workflow.save', payload: { body: { sourceId, name: nm, kind: 'button', actions: [], triggers: [], triggerMode: 'any', viewScopeId: null, propertyId: res.propertyId! } } }])
    }
    onCreated?.(res.propertyId!)
    onClose()
  }
  const choose = (k: Kind) => {
    const cfg: Cfg = k === 'unique_id' ? { allocationMode: 'partitioned' } : k === 'connected' ? { providerId: 'github_pr', connectionId: 'default', exposedFields: [] } : {}
    setKind(k)
    setName('')
    setConfig(cfg)
  }
  const match = (k: Kind) => t(KIND_LABEL[k]).toLowerCase().includes(q.toLowerCase())
  return (
    <Popover anchor={anchor} onClose={onClose}>
      {!kind ? (
        <Panel title={t('New property')} className="dv-picker">
          <Field autoFocus placeholder={t('Search property types…')} aria-label={t('Search property types…')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="dv-choices" role="listbox" aria-label={t('Property type')}>
            {KIND_GROUPS.map((g) => {
              const kinds = g.kinds.filter(match)
              return kinds.length ? (
                <div key={g.label} role="group" aria-label={t(g.label)}>
                  <div className="ds-menu-head">{t(g.label)}</div>
                  {kinds.map((k) => (
                    <button key={k} type="button" role="option" aria-selected={false} className="ds-menu-item" onClick={() => choose(k)}>
                      <KindIcon kind={k} />
                      <span className="ds-menu-label">{t(KIND_LABEL[k])}</span>
                    </button>
                  ))}
                </div>
              ) : null
            })}
          </div>
        </Panel>
      ) : (
        <Panel
          title={
            <span className="dv-panel-kind">
              <KindIcon kind={kind} /> {t(KIND_LABEL[kind])}
            </span>
          }
          onBack={() => setKind(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t('Cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void create()}>
                {t('Create property')}
              </Button>
            </>
          }
        >
          <FormField label={t('Name')}>
            <Field autoFocus value={name} placeholder={t(KIND_LABEL[kind])} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void create()} />
          </FormField>
          <ConfigForm svc={svc} kind={kind} sourceId={sourceId} selfId={null} config={config} onChange={setConfig} />
          {!NEEDS_SETUP.includes(kind) && <Hint>{t('You can change these settings later from the column menu.')}</Hint>}
          {err && <ErrorLine>{err}</ErrorLine>}
        </Panel>
      )}
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
  const plan: ConvertPlan = useMemo(
    () => ({
      propertyId: def.id,
      destinationKind: to,
      invalidPolicy: policy,
      ...(to === 'select' || to === 'multi_select' || to === 'status' ? { destinationConfig: from(def, to) } : {}),
      mapping: {
        decimalSeparator: decimal,
        autoCreateOptions: create,
        delimiter: delim || undefined,
        dateFormat: (dateFmt || undefined) as never,
        pick: pick ? 'first_by_order' : undefined,
        zone: svc.zone,
        timestampUnit: 'ms',
      },
    }),
    [def, to, policy, decimal, create, delim, dateFmt, pick, svc.zone],
  )
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
    <Dialog
      open
      title={t('Change “{n}” to…', { n: def.name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" disabled={!report?.supported || (report.counts.invalid > 0 && policy === 'rejectInvalid')} onClick={() => void go()}>
            {t('Change type')}
          </Button>
        </>
      }
    >
      <div className="ds-modal-body">
        <FormField label={t('New type')}>
          <Dropdown label={t('New type')} value={to} options={CONVERT_TARGETS.filter((k) => k !== def.kind).map((k) => ({ value: k, label: KIND_LABEL[k] }))} onChange={(v) => setTo(v)} />
        </FormField>
        {def.kind === 'text' && to === 'number' && (
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
        )}
        {def.kind === 'text' && to === 'date' && (
          <FormField label={t('Date format')} hint={t('Without a format only ISO dates (2026-10-25) convert; ambiguous dates such as 01/02/03 are reported, not guessed.')}>
            <Dropdown
              label={t('Date format')}
              value={dateFmt}
              options={[
                { value: '', label: 'ISO (YYYY-MM-DD)', raw: true },
                { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY', raw: true },
                { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY', raw: true },
                { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD', raw: true },
                { value: 'jalali', label: 'Jalali (YYYY/MM/DD)' },
              ]}
              onChange={setDateFmt}
            />
          </FormField>
        )}
        {def.kind === 'text' && (to === 'select' || to === 'multi_select' || to === 'status') && (
          <>
            <SwitchRow label={t('Create an option for every different text')} checked={create} onChange={setCreate} />
            {to === 'multi_select' && (
              <FormField label={t('Split on')} hint={t('Commas are never split unless you choose a separator.')}>
                <Field ltr value={delim} maxLength={3} onChange={(e) => setDelim(e.target.value)} placeholder="," />
              </FormField>
            )}
          </>
        )}
        {def.kind === 'multi_select' && to === 'select' && <SwitchRow label={t('When several are selected, keep the first by option order')} checked={pick} onChange={setPick} />}
        {report && !report.supported && <ErrorLine>{report.unsupportedReason}</ErrorLine>}
        {report?.supported && (
          <ConversionSummary report={report} policy={policy} onPolicy={setPolicy} />
        )}
        {err && <ErrorLine>{err}</ErrorLine>}
      </div>
    </Dialog>
  )
}

function ConversionSummary({ report, policy, onPolicy }: { report: ConversionReport; policy: 'rejectInvalid' | 'clearInvalid'; onPolicy: (p: 'rejectInvalid' | 'clearInvalid') => void }) {
  return (
    <div className="dv-report">
      <p className="dv-report-line">
        {t('{n} convert cleanly', { n: report.counts.lossless })} · {t('{n} lose detail', { n: report.counts.lossy })} · <b data-bad={report.counts.invalid > 0 || undefined}>{t('{n} cannot convert', { n: report.counts.invalid })}</b>
      </p>
      <ul className="dv-samples">
        {report.invalid.slice(0, 5).map((e) => (
          <li key={e.pageId} data-bad dir="auto">
            “{e.before}” — {e.reason}
          </li>
        ))}
        {report.samples
          .filter((e) => e.loss !== 'invalid')
          .slice(0, 5)
          .map((e) => (
            <li key={e.pageId} dir="auto">
              {e.before || '∅'} → {e.after || '∅'}
            </li>
          ))}
      </ul>
      {report.counts.invalid > 0 && (
        <FormField label={t('Cells that cannot convert')}>
          <Segmented
            label={t('Cells that cannot convert')}
            value={policy}
            onChange={onPolicy}
            options={[
              { value: 'rejectInvalid', label: t('Cancel the change') },
              { value: 'clearInvalid', label: t('Clear them (originals are kept in history)') },
            ]}
          />
        </FormField>
      )}
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
  frozen?: boolean
  sort?: (dir: 'asc' | 'desc') => void
  filter?: () => void
}

/** Everything about one property in one panel: its name, then its actions, with its settings one step in. */
export function PropertyMenu({
  svc,
  def,
  anchor,
  onClose,
  actions,
  onEditActions,
}: {
  svc: DatabaseService
  def: Definition
  anchor: DOMRect
  onClose: () => void
  actions: ColumnActions
  onEditActions?: (def: Definition) => void
}) {
  const [step, setStep] = useState<'menu' | 'settings'>('menu')
  const [name, setName] = useState(def.name)
  const [config, setConfig] = useState<Cfg>(def.config as Cfg)
  const [convert, setConvert] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isTitle = def.kind === 'title'
  const canSchema = svc.access().sourceCaps(svc.principalId, def.sourceId).has('edit_schema')
  const hasSettings = !['title', 'text', 'checkbox', 'url', 'email', 'phone', 'created_by', 'last_edited_by'].includes(def.kind)
  const save = async (close = true) => {
    const patch: Record<string, Json> = {}
    if (name.trim() && name.trim() !== def.name) patch.name = name.trim()
    const noOpts = Object.fromEntries(
      Object.entries(config).filter(([k]) => !['options', 'groups', 'defaultOptionId', 'archivedOptions', 'definitionId', 'side', 'ast', 'resolvedRefs', 'resultType', 'languageVersion'].includes(k)),
    )
    const r = await svc.tryExec([
      {
        type: 'property.configure',
        payload: {
          propertyId: def.id,
          ...patch,
          ...(def.kind === 'formula' ? { configPatch: { source: (config.source as string) ?? '' } } : DESCRIPTORS[def.kind].storage === 'derived' || def.kind === 'relation' ? {} : { configPatch: noOpts as Json }),
        },
      },
    ])
    if (!r.ok) return setErr(errorText(r.code, r.message))
    if (close) onClose()
  }
  const del = async () => {
    const deps = svc.state.live('property').filter((p) => (p.kind === 'formula' || p.kind === 'rollup') && JSON.stringify(p.config).includes(def.id) && p.id !== def.id)
    const ok = await confirmDialog({
      title: t('Delete “{n}”?', { n: def.name }),
      message: deps.length
        ? t('{k} other properties depend on it and will show an error. You can restore it from the trash menu.', { k: deps.length })
        : t('Its values are kept, so you can restore the property later.'),
      danger: true,
      confirmLabel: t('Delete'),
    })
    if (!ok) return
    const r = await svc.tryExec([{ type: 'property.delete', payload: { propertyId: def.id } }])
    if (!r.ok) setErr(errorText(r.code, r.message))
    else onClose()
  }
  if (convert) return <ConvertDialog svc={svc} def={def} onClose={() => (setConvert(false), onClose())} />
  const item = (icon: string, label: string, run: () => void, danger?: boolean) => (
    <button type="button" role="menuitem" className="ds-menu-item" data-danger={danger || undefined} onClick={run}>
      <Icon name={icon} size={16} />
      <span className="ds-menu-label">{label}</span>
    </button>
  )
  return (
    <Popover anchor={anchor} onClose={onClose}>
      {step === 'menu' ? (
        <Panel size="sm" className="dv-colmenu">
          <div className="dv-colmenu-name">
            <KindIcon kind={def.kind} />
            <Field
              aria-label={t('Property name')}
              value={name}
              disabled={!canSchema}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== def.name && void save(false)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void save()}
            />
          </div>
          <p className="dv-hint">{t(KIND_LABEL[def.kind])}</p>
          {err && <ErrorLine>{err}</ErrorLine>}
          <div className="dv-colmenu-items" role="menu" aria-label={def.name}>
            {canSchema && hasSettings && item('settings', t('Edit property'), () => setStep('settings'))}
            {canSchema && def.kind === 'button' && onEditActions && item('pointer', t('Edit actions'), () => (onClose(), onEditActions(def)))}
            {canSchema && !isTitle && DESCRIPTORS[def.kind].storage !== 'system' && def.kind !== 'unique_id' && item('swap', t('Change type'), () => setConvert(true))}
            {(actions.sort || actions.filter || actions.freeze || actions.hide) && <div className="ds-menu-sep" role="separator" />}
            {actions.sort && item('arrow-up', t('Sort ascending'), () => (actions.sort!('asc'), onClose()))}
            {actions.sort && item('arrow-down', t('Sort descending'), () => (actions.sort!('desc'), onClose()))}
            {actions.filter && DESCRIPTORS[def.kind].queryable && item('filter', t('Filter by this'), () => (actions.filter!(), onClose()))}
            {actions.freeze && item('pin', actions.frozen ? t('Unfreeze columns') : t('Freeze up to here'), () => (actions.freeze!(), onClose()))}
            {actions.hide && !isTitle && item('eye-off', t('Hide in this view'), () => (actions.hide!(), onClose()))}
            {canSchema && !isTitle && <div className="ds-menu-sep" role="separator" />}
            {canSchema && !isTitle && item('trash', t('Delete property'), () => void del(), true)}
          </div>
        </Panel>
      ) : (
        <Panel
          title={def.name}
          onBack={() => setStep('menu')}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t('Cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save()}>
                {t('Save changes')}
              </Button>
            </>
          }
        >
          <ConfigForm svc={svc} kind={def.kind} sourceId={def.sourceId} selfId={def.id} config={config} onChange={setConfig} />
          {err && <ErrorLine>{err}</ErrorLine>}
        </Panel>
      )}
    </Popover>
  )
}

export { Chip, staticType }
