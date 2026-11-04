// Dashboard: rows of widgets, each a child view of the dashboard (any non-dashboard layout). An optional global filter is mapped
// per source by the editor; unmapped widgets say they are not affected. Widgets load lazily when they scroll into view.
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react'
import type { Id, Json, View } from '../model/types.ts'
import { effectiveFilter, suggestMappings } from '../viewLogic.ts'
import { Button, Dropdown, FormField, Icon, IconButton, Segmented } from '../../design-system'
import { t } from '../../i18n'
import { Hint, ViewMessage, errorText, rawOptions } from './common'
import { VIEW_LABEL, ViewIcon } from './viewMeta'
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

function WidgetFrame({
  p,
  w,
  global,
  editing,
  span,
  onSpan,
  onRemove,
}: {
  p: ViewProps
  w: View
  global: Global | null
  editing: boolean
  span: number
  onSpan: (span: 1 | 2 | 3) => void
  onRemove: () => void
}) {
  const ref = useRef<HTMLElement>(null)
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
    <section className="dv-widget" data-editing={editing || undefined} ref={ref} aria-label={w.name}>
      <header className="dv-widget-head">
        <ViewIcon type={w.type} size={16} />
        <b dir="auto">{w.name}</b>
        <small dir="auto">{src?.name ?? t(VIEW_LABEL[w.type])}</small>
        {global && !eff.affected && (
          <small className="dv-widget-na" title={t('The global filter is not mapped to this widget’s data.')}>
            · {t('Not affected by the filter')}
          </small>
        )}
        {editing && (
          <span className="dv-widget-acts">
            <Segmented
              label={t('Widget width')}
              value={String(span) as '1' | '2' | '3'}
              onChange={(value) => onSpan(Number(value) as 1 | 2 | 3)}
              options={[
                { value: '1', label: t('Normal'), title: t('Normal width') },
                { value: '2', label: t('Wide'), title: t('Twice as wide') },
                { value: '3', label: t('Extra wide'), title: t('Three times as wide') },
              ]}
            />
            <IconButton label={t('Remove widget')} onClick={onRemove}>
              <Icon name="trash" size={15} />
            </IconButton>
          </span>
        )}
      </header>
      <div className="dv-widget-body">
        {seen && V ? (
          <Suspense
            fallback={
              <div className="dv-loading" role="status">
                {t('Loading…')}
              </div>
            }
          >
            <V svc={p.svc} view={shown} container={p.container} ctl={ctl} />
          </Suspense>
        ) : !V ? (
          <ViewMessage title={t('This layout cannot be shown in a dashboard.')} />
        ) : (
          <div className="dv-loading" />
        )}
      </div>
    </section>
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
  const [adding, setAdding] = useState<{ sourceId: Id; type: string }>({ sourceId: sources[0]?.id ?? '', type: 'chart' })

  const saveRows = (next: Row[]) => ctl.patch({ rows: next as unknown as Json })
  const addWidget = async () => {
    if (!adding.sourceId) return
    const r = await svc.tryExec([
      { type: 'view.create', payload: { containerId: container.id, sourceId: adding.sourceId, type: adding.type, name: t(VIEW_LABEL[adding.type as keyof typeof VIEW_LABEL]), parentDashboardId: view.id } },
    ])
    if (!r.ok) return ctl.notice(errorText(r.code, r.message))
    const viewId = (r.result as { viewId: Id }).viewId
    const last = rows[rows.length - 1]
    await saveRows(last && last.widgets.length < 2 ? [...rows.slice(0, -1), { widgets: [...last.widgets, { viewId }] }] : [...rows, { widgets: [{ viewId }] }])
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
    void setGlobal({
      propertyId: id,
      op,
      operand: defaultFilterOperand(svc, def, op),
      mappings: Object.fromEntries([[def.sourceId, id], ...suggestMappings(svc.state, id).map((match) => [match.sourceId, match.propertyId])]),
    })
  }

  return (
    <div className="dv-dash">
      <header className="dv-period">
        <h3 className="dv-period-title">{t('{n} widgets', { n: widgets.length })}</h3>
        {ctl.canSchema && (
          <span className="dv-period-end">
            <Button size="sm" variant={editing ? 'primary' : 'default'} aria-pressed={editing} icon={<Icon name={editing ? 'check' : 'pencil'} size={15} />} onClick={() => setEditing(!editing)}>
              {editing ? t('Done editing') : t('Edit dashboard')}
            </Button>
          </span>
        )}
      </header>

      {(g || editing) && (
        <section className="dv-dash-filter" aria-label={t('Global filter')}>
          <span className="dv-dash-filter-label">
            <Icon name="filter" size={15} /> {t('Filter every widget by')}
          </span>
          <Dropdown
            className="ds-dd-btn--sm"
            label={t('Property')}
            placeholder={t('Choose a property…')}
            value={g?.propertyId ?? ''}
            disabled={!ctl.canSchema}
            onChange={selectGlobal}
            options={globalProperties.map((property) => ({
              value: property.id,
              label: sources.length > 1 ? (svc.state.get('source', property.sourceId)?.name ?? '') + ' · ' + property.name : property.name,
              raw: true,
            }))}
          />
          {g && globalDefinition && (
            <>
              <Dropdown
                className="ds-dd-btn--sm"
                label={t('Condition')}
                value={g.op}
                disabled={!ctl.canSchema}
                onChange={(op) => void setGlobal({ ...g, op, operand: defaultFilterOperand(svc, globalDefinition, op) })}
                options={globalOperators.map((op) => ({ value: op, label: filterOperatorLabel(op), raw: true }))}
              />
              {!['is_empty', 'is_not_empty'].includes(g.op) && (
                <fieldset className="dv-fieldset" disabled={!ctl.canSchema}>
                  <FilterOperand svc={svc} def={globalDefinition} op={g.op} value={g.operand} onChange={(operand) => void setGlobal({ ...g, operand })} />
                </fieldset>
              )}
              {editing && (
                <IconButton label={t('Remove the global filter')} onClick={() => void setGlobal(null)}>
                  <Icon name="x" size={15} />
                </IconButton>
              )}
            </>
          )}
          {editing && g && sources.length > 1 && (
            <div className="dv-dash-mappings">
              <span className="dv-hint">{t('Match properties')}</span>
              {sources.map((source) => (
                <FormField key={source.id} label={source.name}>
                  <Dropdown
                    label={source.name}
                    value={g.mappings[source.id] ?? ''}
                    onChange={(id) => void setGlobal({ ...g, mappings: { ...g.mappings, [source.id]: id } })}
                    options={[{ value: '', label: 'Not mapped' }, ...rawOptions(filterableProps(svc, source.id))]}
                  />
                </FormField>
              ))}
            </div>
          )}
        </section>
      )}

      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="dv-dash-row" style={{ ['--dv-dash-cols' as string]: row.widgets.map((widget) => 'minmax(0, ' + (widget.span ?? 1) + 'fr)').join(' ') }}>
          {row.widgets.map((item, index) => {
            const widget = byId.get(item.viewId)
            return widget ? (
              <WidgetFrame
                key={item.viewId}
                p={p}
                w={widget}
                global={g}
                editing={editing}
                span={item.span ?? 1}
                onSpan={(span) => void saveRows(rows.map((current, i) => (i === rowIndex ? { widgets: current.widgets.map((entry, j) => (j === index ? { ...entry, span } : entry)) } : current)))}
                onRemove={() => void remove(item.viewId)}
              />
            ) : null
          })}
        </div>
      ))}
      {widgets.some((widget) => !placed.has(widget.id)) && editing && (
        <Hint>
          {t('Some widgets are not placed in a row.')}{' '}
          <Button size="sm" variant="ghost" onClick={() => void saveRows([...rows, ...widgets.filter((widget) => !placed.has(widget.id)).map((widget) => ({ widgets: [{ viewId: widget.id }] }))])}>
            {t('Place remaining widgets')}
          </Button>
        </Hint>
      )}
      {rows.length === 0 && !editing && (
        <ViewMessage
          title={t('This dashboard is empty')}
          action={
            ctl.canSchema && (
              <Button size="sm" variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setEditing(true)}>
                {t('Add widget')}
              </Button>
            )
          }
        >
          {t('Add charts, tables and other views to build your dashboard.')}
        </ViewMessage>
      )}

      {editing && ctl.canSchema && (
        <section className="dv-dash-add" aria-label={t('Add widget')}>
          <b>{t('Add widget')}</b>
          {sources.length > 1 && <Dropdown className="ds-dd-btn--sm" label={t('Data source')} value={adding.sourceId} onChange={(sourceId) => setAdding({ ...adding, sourceId })} options={rawOptions(sources)} />}
          <Dropdown
            className="ds-dd-btn--sm"
            label={t('Layout')}
            value={adding.type}
            onChange={(type) => setAdding({ ...adding, type })}
            options={Object.keys(KINDS).map((kind) => ({ value: kind, label: VIEW_LABEL[kind as keyof typeof VIEW_LABEL] }))}
          />
          <Button size="sm" variant="primary" icon={<Icon name="plus" size={15} />} disabled={!adding.sourceId} onClick={() => void addWidget()}>
            {t('Add')}
          </Button>
        </section>
      )}
    </div>
  )
}
