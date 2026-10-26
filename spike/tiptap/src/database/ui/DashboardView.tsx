// Dashboard: rows of widgets, each a child view of the dashboard (any non-dashboard layout). An optional global filter is mapped
// per source by the editor; unmapped widgets say they are not affected. Widgets load lazily when they scroll into view.
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react'
import type { Id, Json, View } from '../model/types.ts'
import { effectiveFilter, suggestMappings } from '../viewLogic.ts'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { errorText } from './common'
import { Field } from './forms'
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

function WidgetFrame({ p, w, global, editing, onRemove }: { p: ViewProps; w: View; global: Global | null; editing: boolean; onRemove: () => void }) {
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
    canSchema: p.ctl.canSchema,
  }
  return (
    <div className={'db-widget' + (editing ? ' editing' : '')} ref={ref}>
      <div className="db-widget-head">
        <b dir="auto">{w.name}</b>
        {src && <small dir="auto">{src.name}</small>}
        {global && !eff.affected && <small className="db-widget-na" title={t('The global filter is not mapped to this widget’s data.')}>{t('Not affected by the filter')}</small>}
        <span className="spacer" />
        {editing && <button type="button" className="icon-btn" aria-label={t('Remove widget')} onClick={onRemove}><Ic.Close size={12} /></button>}
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
  const g = cfg.globalFilter ?? null
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
  const firstProp = (sid: Id) => svc.state.props(sid).find((x) => x.kind !== 'button')

  return (
    <div className="db-dash">
      {ctl.canSchema && (
        <div className="db-dash-bar">
          <button type="button" className={'db-tool' + (editing ? ' on' : '')} aria-pressed={editing} onClick={() => setEditing(!editing)}><Ic.Settings size={13} /> {editing ? t('Done editing') : t('Edit dashboard')}</button>
        </div>
      )}
      {(g || editing) && (
        <div className="db-dash-global" role="group" aria-label={t('Global filter')}>
          {g ? (
            <>
              <b>{t('Global filter')}</b>
              <span dir="auto">{svc.state.prop(g.propertyId)?.name ?? t('Deleted property')}</span>
              <select aria-label={t('Condition')} value={g.op} disabled={!ctl.canSchema} onChange={(e) => void setGlobal({ ...g, op: e.target.value })}>{['equals', 'does_not_equal', 'contains', 'is_empty', 'is_not_empty'].map((o) => <option key={o} value={o}>{t(o.replace(/_/g, ' '))}</option>)}</select>
              {['equals', 'does_not_equal', 'contains'].includes(g.op) && <input dir="auto" aria-label={t('Value')} value={(g.operand as string) ?? ''} onChange={(e) => void setGlobal({ ...g, operand: e.target.value })} />}
              {editing && sources.map((s) => {
                const props = svc.state.props(s.id)
                return (
                  <label key={s.id} className="db-map-pick"><span dir="auto">{s.name}</span>
                    <select value={g.mappings[s.id] ?? ''} onChange={(e) => void setGlobal({ ...g, mappings: { ...g.mappings, [s.id]: e.target.value } })}>
                      <option value="">{t('Not mapped')}</option>
                      {props.map((x) => <option key={x.id} value={x.id}>{x.name}{suggestMappings(svc.state, g.propertyId).some((m) => m.propertyId === x.id) ? ' ✓' : ''}</option>)}
                    </select>
                  </label>
                )
              })}
              {editing && <button type="button" onClick={() => void setGlobal(null)}>{t('Remove')}</button>}
            </>
          ) : sources[0] && firstProp(sources[0].id) ? (
            <Field label={t('Add a global filter')}>
              <select value="" onChange={(e) => { if (e.target.value) void setGlobal({ propertyId: e.target.value, op: 'contains', operand: '', mappings: Object.fromEntries([[svc.state.prop(e.target.value)!.sourceId, e.target.value], ...suggestMappings(svc.state, e.target.value).map((m) => [m.sourceId, m.propertyId])]) }) }}>
                <option value="">{t('Choose a property…')}</option>
                {sources.flatMap((s) => svc.state.props(s.id).filter((x) => ['select', 'status', 'text', 'title', 'people', 'checkbox'].includes(x.kind)).map((x) => <option key={x.id} value={x.id}>{s.name} · {x.name}</option>))}
              </select>
            </Field>
          ) : null}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="db-dash-row" style={{ gridTemplateColumns: r.widgets.map((x) => `${x.span ?? 1}fr`).join(' ') }}>
          {r.widgets.map((x) => {
            const w = byId.get(x.viewId)
            return w ? <WidgetFrame key={x.viewId} p={p} w={w} global={g} editing={editing} onRemove={() => void remove(x.viewId)} /> : null
          })}
        </div>
      ))}
      {widgets.filter((w) => !placed.has(w.id)).length > 0 && editing && <div className="db-date-hint">{t('Some widgets are not placed in a row.')}</div>}
      {rows.length === 0 && !editing && <div className="db-empty"><b>{t('This dashboard is empty')}</b>{ctl.canSchema && <p>{t('Choose Edit dashboard to add charts and views.')}</p>}</div>}
      {editing && ctl.canSchema && (
        <div className="db-dash-add">
          <select aria-label={t('Data source')} value={adding?.sourceId ?? ''} onChange={(e) => setAdding({ sourceId: e.target.value, type: adding?.type ?? 'chart' })}>
            <option value="">{t('Choose data…')}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label={t('Layout')} value={adding?.type ?? 'chart'} onChange={(e) => adding && setAdding({ ...adding, type: e.target.value })} disabled={!adding}>
            {Object.keys(KINDS).map((k) => <option key={k} value={k}>{t(k[0].toUpperCase() + k.slice(1))}</option>)}
          </select>
          <button type="button" className="primary" disabled={!adding} onClick={() => void addWidget()}><Ic.Plus size={13} /> {t('Add widget')}</button>
        </div>
      )}
    </div>
  )
}
