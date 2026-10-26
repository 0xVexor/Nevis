// Dashboard: rows of widgets, each a child view of the dashboard (any non-dashboard layout). An optional global filter is mapped
// per source by the editor; unmapped widgets say they are not affected. Widgets load lazily when they scroll into view.
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react'
import type { Id, Json, View } from '../model/types.ts'
import { effectiveFilter, suggestMappings } from '../viewLogic.ts'
import { t } from '../../i18n'
import { Select } from '../../ui'
import * as Ic from '../../icons'
import { errorText } from './common'
import { Field } from './forms'
import { VIEW_ICON, VIEW_LABEL } from './viewMeta'
import { FilterOperand, defaultFilterOperand, filterableProps, filterOperatorLabel } from './ViewControls'
import { OPS } from '../props/registry.ts'
import { filterClass } from '../query/engine.ts'
import type { ViewProps } from './viewTypes'

type Widget = { viewId: Id; span?: 1 | 2 | 3 }
type Row = { widgets: Widget[] }
type Global = { propertyId: Id; op: string; operand?: Json; mappings: Record<Id, Id> }
type Cfg = { rows?: Row[]; globalFilter?: Global | null }

const lz = (f: () => Promise<{ default: ComponentType<ViewProps> }>) => lazy(f)
const KINDS: Record<string, ComponentType<ViewProps>> = {
  table: lz(() => import('./TableView').then((m) => ({ default: m.TableView as ComponentType<ViewProps> }))),
  board: lz(() => import('./BoardViews').then((m) => ({ default: m.DatabaseBoardView }))),
  list: lz(() => import('./BoardViews').then((m) => ({ default: m.ListView }))),
  gallery: lz(() => import('./BoardViews').then((m) => ({ default: m.GalleryView }))),
  calendar: lz(() => import('./ScheduleViews').then((m) => ({ default: m.CalendarView }))),
  timeline: lz(() => import('./ScheduleViews').then((m) => ({ default: m.TimelineView }))),
  chart: lz(() => import('./ChartView').then((m) => ({ default: m.ChartView }))),
  map: lz(() => import('./MapView').then((m) => ({ default: m.MapView }))),
  feed: lz(() => import('./FeedView').then((m) => ({ default: m.FeedView }))),
}

function WidgetFrame({ p, w, global, editing, span, onSpan, onRemove }: { p: ViewProps; w: View; global: Global | null; editing: boolean; span: number; onSpan: (span: 1 | 2 | 3) => void; onRemove: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  const src = w.sourceId ? p.svc.state.get('source', w.sourceId) : null
  const gl = global ? { predicate: { op: global.op, operand: global.operand }, mappings: global.mappings } : null
  const eff = w.sourceId ? effectiveFilter(w.filter, null, gl, w.sourceId) : { filter: w.filter, affected: true }
  const shown: View = { ...w, filter: eff.filter }
  const V = KINDS[w.type]
  const ctl: ViewProps['ctl'] = {
    ...p.ctl,
    patch: async (config) => {
      const r = await p.svc.tryExec([{ type: 'view.patch', payload: { viewId: w.id, configurationPatch: config } }])
      if (!r.ok) p.ctl.notice(errorText(r.code, r.message))
      return r.ok
    },
    createRow: async () => null,
    canEditRows: false,
    canSchema: p.ctl.canSchema && editing,
  }
  return (
    <div className={'db-widget' + (editing ? ' editing' : '')} ref={ref}>
      <div className="db-widget-head">
        <span className="db-panel-icon">{VIEW_ICON[w.type]()}</span>
        <div className="db-widget-titles"><b dir="auto">{w.name}</b><small dir="auto">{src?.name ?? t(VIEW_LABEL[w.type])}</small></div>
        {global && !eff.affected && <small className="db-widget-na" title={t('The global filter is not mapped to this widget’s data.')}>{t('Not affected by the filter')}</small>}
        <span className="spacer" />
        {editing && <div className="db-widget-actions">
          <Select className="db-widget-width" title={t('Widget width')} value={String(span)} onChange={(value) => onSpan(Number(value) as 1 | 2 | 3)} options={[{ value: '1', label: t('Normal') }, { value: '2', label: t('Wide') }, { value: '3', label: t('Extra wide') }]} />
          <button type="button" className="icon-btn danger" aria-label={t('Remove widget')} title={t('Remove widget')} onClick={onRemove}><Ic.Trash size={14} /></button>
        </div>}
      </div>
      <div className="db-widget-body">
        {seen && V ? <Suspense fallback={<div className="db-loading" role="status">{t('Loading…')}</div>}><V svc={p.svc} view={shown} container={p.container} ctl={ctl} /></Suspense> : !V ? <div className="db-error-box">{t('This layout cannot be shown in a dashboard.')}</div> : <div className="db-loading" />}
      </div>
    </div>
  )
}

export function DashboardView(p: ViewProps) {
  const { svc, view, container, ctl } = p
  const cfg = view.configuration as Cfg
  const rows = cfg.rows ?? []
  const widgets = svc.state.viewsOf(container.id).filter((v) => v.parentDashboardId === view.id)
  const byId = new Map(widgets.map((v) => [v.id, v]))
  const placed = new Set(rows.flatMap((r) => r.widgets.map((x) => x.viewId)))
  const [editing, setEditing] = useState(false)
  const savedGlobal = cfg.globalFilter ?? null
  const g = savedGlobal ? { ...savedGlobal, op: savedGlobal.op === 'does_not_equal' ? 'not_equals' : savedGlobal.op } : null
  const sources = container.sourceLinks.map((l) => svc.state.get('source', l.sourceId)).filter((s): s is NonNullable<typeof s> => !!s && s.deletedAt === null)
  const [adding, setAdding] = useState<{ sourceId: Id; type: string } | null>(null)

  const saveRows = (next: Row[]) => ctl.patch({ rows: next as unknown as Json })
  const addWidget = async () => {
    if (!adding) return
    const r = await svc.tryExec([{ type: 'view.create', payload: { containerId: container.id, sourceId: adding.sourceId, type: adding.type, name: t(adding.type[0].toUpperCase() + adding.type.slice(1)), parentDashboardId: view.id } }])
    if (!r.ok) return ctl.notice(errorText(r.code, r.message))
    const viewId = (r.result as { viewId: Id }).viewId
    const last = rows[rows.length - 1]
    await saveRows(last && last.widgets.length < 2 ? [...rows.slice(0, -1), { widgets: [...last.widgets, { viewId }] }] : [...rows, { widgets: [{ viewId }] }])
    setAdding(null)
  }
  const remove = async (id: Id) => {
    await saveRows(rows.map((r) => ({ widgets: r.widgets.filter((x) => x.viewId !== id) })).filter((r) => r.widgets.length))
    await svc.tryExec([{ type: 'view.delete', payload: { viewId: id } }])
  }
  const setGlobal = (next: Global | null) => ctl.patch({ globalFilter: next as unknown as Json })
  const globalProperties = sources.flatMap((source) => filterableProps(svc, source.id))
  const globalDefinition = g ? svc.state.prop(g.propertyId) : undefined
  const globalOperators = globalDefinition ? OPS[filterClass(svc.state, globalDefinition)] : []
  const selectGlobal = (id: Id) => {
    const def = svc.state.prop(id)
    if (!def) return
    const operators = OPS[filterClass(svc.state, def)]
    const op = operators.includes('contains') ? 'contains' : operators[0]
    if (!op) return
    void setGlobal({ propertyId: id, op, operand: defaultFilterOperand(svc, def, op), mappings: Object.fromEntries([[def.sourceId, id], ...suggestMappings(svc.state, id).map((match) => [match.sourceId, match.propertyId])]) })
  }

  return (
    <div className="db-dash">
      <header className="db-dash-header">
        <div className="db-section-heading"><span className="db-panel-icon"><Ic.Layers size={20} /></span><div><h2 dir="auto">{view.name}</h2><p>{t('Bring your views together in one place.')}</p></div></div>
        <div className="db-view-actions"><span className="db-count">{widgets.length} {t('Widgets')}</span>{ctl.canSchema && <button type="button" className={editing ? 'primary' : 'db-btn'} aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? <Ic.Check size={15} /> : <Ic.Settings size={15} />}{editing ? t('Done editing') : t('Edit dashboard')}</button>}</div>
      </header>

      {(g || editing) && <section className="db-panel db-dash-global" aria-label={t('Global filter')}>
        <header className="db-panel-head"><span className="db-panel-icon"><Ic.Search size={16} /></span><div><h3>{t('Global filter')}</h3><p>{t('Apply one filter across your widgets.')}</p></div><span className="spacer" />{editing && g && <button type="button" className="db-btn danger" onClick={() => void setGlobal(null)}><Ic.Trash size={14} />{t('Remove')}</button>}</header>
        <div className="db-panel-body">
          <div className="db-dash-filter-fields">
            <Field label={g ? t('Property') : t('Add a global filter')}><Select title={t('Property')} value={g?.propertyId ?? ''} disabled={!ctl.canSchema} onChange={selectGlobal} options={[{ value: '', label: t('Choose a property…') }, ...globalProperties.map((property) => ({ value: property.id, label: sources.length > 1 ? (svc.state.get('source', property.sourceId)?.name ?? '') + ' · ' + property.name : property.name }))]} /></Field>
            {g && globalDefinition && <><Field label={t('Condition')}><Select title={t('Condition')} value={g.op} disabled={!ctl.canSchema} onChange={(op) => void setGlobal({ ...g, op, operand: defaultFilterOperand(svc, globalDefinition, op) })} options={globalOperators.map((op) => ({ value: op, label: filterOperatorLabel(op) }))} /></Field>
            {!['is_empty', 'is_not_empty'].includes(g.op) && <div className="db-field"><span className="db-field-l">{t('Value')}</span><fieldset className="db-filter-value" disabled={!ctl.canSchema}><FilterOperand svc={svc} def={globalDefinition} op={g.op} value={g.operand} onChange={(operand) => void setGlobal({ ...g, operand })} /></fieldset></div>}</>}
          </div>
          {editing && g && sources.length > 1 && <div className="db-dash-mappings"><span className="db-field-l">{t('Match properties')}</span>{sources.map((source) => <Field key={source.id} label={source.name}><Select title={source.name} value={g.mappings[source.id] ?? ''} onChange={(id) => void setGlobal({ ...g, mappings: { ...g.mappings, [source.id]: id } })} options={[{ value: '', label: t('Not mapped') }, ...filterableProps(svc, source.id).map((property) => ({ value: property.id, label: property.name }))]} /></Field>)}</div>}
        </div>
      </section>}

      {rows.map((row, rowIndex) => <div key={rowIndex} className="db-dash-row" style={{ gridTemplateColumns: row.widgets.map((widget) => 'minmax(0, ' + (widget.span ?? 1) + 'fr)').join(' ') }}>
        {row.widgets.map((item, index) => {
          const widget = byId.get(item.viewId)
          return widget ? <WidgetFrame key={item.viewId} p={p} w={widget} global={g} editing={editing} span={item.span ?? 1} onSpan={(span) => void saveRows(rows.map((current, i) => i === rowIndex ? { widgets: current.widgets.map((entry, j) => j === index ? { ...entry, span } : entry) } : current))} onRemove={() => void remove(item.viewId)} /> : null
        })}
      </div>)}
      {widgets.some((widget) => !placed.has(widget.id)) && editing && <div className="db-empty-hint db-unplaced"><span>{t('Some widgets are not placed in a row.')}</span><button type="button" className="db-btn" onClick={() => void saveRows([...rows, ...widgets.filter((widget) => !placed.has(widget.id)).map((widget) => ({ widgets: [{ viewId: widget.id }] }))])}>{t('Place remaining widgets')}</button></div>}
      {rows.length === 0 && !editing && <div className="db-empty db-dash-empty"><span className="db-empty-icon"><Ic.Layers size={28} /></span><b>{t('This dashboard is empty')}</b><p>{t('Add charts, tables and other views to build your dashboard.')}</p>{ctl.canSchema && <button type="button" className="primary" onClick={() => setEditing(true)}><Ic.Plus size={15} />{t('Add widget')}</button>}</div>}

      {editing && ctl.canSchema && <section className="db-panel db-dash-add">
        <header className="db-panel-head"><span className="db-panel-icon"><Ic.Plus size={18} /></span><div><h3>{t('Add widget')}</h3><p>{t('Choose a data source and a layout for your widget.')}</p></div></header>
        <div className="db-panel-body db-widget-builder"><Field label={t('Data source')}><Select title={t('Data source')} value={adding?.sourceId ?? ''} onChange={(sourceId) => setAdding(sourceId ? { sourceId, type: adding?.type ?? 'chart' } : null)} options={[{ value: '', label: t('Choose data…') }, ...sources.map((source) => ({ value: source.id, label: source.name }))]} /></Field>
          <Field label={t('Layout')}><Select title={t('Layout')} value={adding?.type ?? 'chart'} onChange={(type) => adding && setAdding({ ...adding, type })} disabled={!adding} options={Object.keys(KINDS).map((kind) => ({ value: kind, label: t(VIEW_LABEL[kind as keyof typeof VIEW_LABEL]) }))} /></Field>
          <button type="button" className="primary" disabled={!adding} onClick={() => void addWidget()}><Ic.Plus size={15} />{t('Add widget')}</button>
        </div>
      </section>}
    </div>
  )
}
