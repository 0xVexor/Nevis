// Chart view: configuration on top, an accessible SVG below (also the export), click on a bar opens a read-only drill-down list of
// exactly the rows it counts. The chart itself never writes anything.
import { useMemo, useState } from 'react'
import type { Id, Json } from '../model/types.ts'
import { chartData, chartToSvg, drilldownFilter, type ChartRequest, type ChartType, type Measure } from '../query/chart.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { RollupAggregation } from '../props/config.ts'
import { Select } from '../../ui'
import { download } from '../../backup'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { CellView, useNav } from './CellView'
import { errorText, plainTitle } from './common'
import { Field, Seg, Switch } from './forms'
import { useViewQuery } from './useViewQuery'
import { aggLabel } from './PropertyEditor'
import type { ViewProps } from './viewTypes'

type ChartCfg = {
  type?: ChartType
  categoryPropertyId?: Id | null
  dateBucket?: 'day' | 'week' | 'month' | 'year'
  seriesPropertyId?: Id | null
  measure?: Measure
  order?: 'category' | 'value_desc' | 'value_asc'
  hideEmpty?: boolean
  xTitle?: string
  yTitle?: string
}

const MEASURE_OPS: RollupAggregation[] = ['sum', 'average', 'median', 'min', 'max', 'range', 'count_values', 'count_unique', 'count_empty', 'count_not_empty']

export function ChartView({ svc, view, ctl }: ViewProps) {
  const cfg = ((view.configuration as { chart?: ChartCfg }).chart ?? {}) as ChartCfg
  const nav = useNav()
  const [drill, setDrill] = useState<{ cat: string; series?: string } | null>(null)
  const props = svc.state.props(view.sourceId!).filter((p) => svc.access().canReadProperty(svc.principalId, p))
  const axisOk = props.filter((p) => !['button', 'files', 'unique_id', 'rollup', 'connected'].includes(p.kind) && !(p.kind === 'formula' && p.config && (p.config as { resultType?: string }).resultType?.startsWith('list')))
  const numeric = props.filter((p) => p.kind === 'number' || p.kind === 'formula' || p.kind === 'checkbox')
  const set = (patch: Partial<ChartCfg>) => void ctl.patch({ chart: { ...cfg, ...patch } as unknown as Json })
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1 }) // only for the filter / error state
  const req: ChartRequest | null = useMemo(() => {
    const type = cfg.type ?? 'bar_vertical'
    if (type !== 'number' && !cfg.categoryPropertyId) return null
    return {
      sourceId: view.sourceId!, principalId: svc.principalId, now: svc.nowIso(), zone: svc.zone, type, categoryPropertyId: cfg.categoryPropertyId ?? undefined, dateBucket: cfg.dateBucket,
      seriesPropertyId: cfg.seriesPropertyId ?? undefined, measure: cfg.measure ?? { kind: 'count' }, filter: q.filter, search: ctl.search, order: cfg.order, hideEmpty: cfg.hideEmpty, weekStart: svc.weekStart,
    }
  }, [cfg, view.sourceId, q.filter, ctl.search, svc, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => {
    if (!req) return { data: null, error: null as string | null }
    try { return { data: chartData(svc.state, req), error: null } } catch (e) { return { data: null, error: e instanceof Error ? e.message : String(e) } }
  }, [req, svc]) // eslint-disable-line react-hooks/exhaustive-deps
  const svg = useMemo(() => (result.data ? chartToSvg(result.data, { title: view.name, rtl: document.documentElement.dir === 'rtl', unassignedLabel: t('No value'), xTitle: cfg.xTitle, yTitle: cfg.yTitle, width: 760, height: 380 }) : ''), [result.data, view.name, cfg.xTitle, cfg.yTitle])
  const rowsFor = useMemo(() => {
    if (!drill || !req) return []
    const f = drilldownFilter(svc.state, req, drill.cat, drill.series)
    try { return svc.query(view.sourceId!, { filter: f, limit: 200, search: ctl.search }).pageIds } catch { return [] }
  }, [drill, req, svc, view.sourceId, ctl.search]) // eslint-disable-line react-hooks/exhaustive-deps
  const exportSvg = () => download(`${view.name}.svg`, new Blob([svg], { type: 'image/svg+xml' }))
  const exportPng = () => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width * 2
      c.height = img.height * 2
      const g = c.getContext('2d')!
      g.scale(2, 2)
      g.drawImage(img, 0, 0)
      c.toBlob((b) => b && download(`${view.name}.png`, b))
      URL.revokeObjectURL(url)
    }
    img.src = url
  }
  const measure = cfg.measure ?? { kind: 'count' as const }
  return (
    <div className="db-chart">
      <div className="db-chart-cfg">
        <Seg value={cfg.type ?? 'bar_vertical'} onChange={(v) => set({ type: v })} label={t('Chart type')} options={[{ value: 'bar_vertical', label: t('Bars') }, { value: 'bar_horizontal', label: t('Horizontal') }, { value: 'line', label: t('Line') }, { value: 'donut', label: t('Donut') }, { value: 'number', label: t('Number') }]} />
        {(cfg.type ?? 'bar_vertical') !== 'number' && (
          <>
            <Field label={t('X axis')}><Select value={cfg.categoryPropertyId ?? ''} options={[{ value: '', label: t('Choose…') }, ...axisOk.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ categoryPropertyId: v || null })} /></Field>
            {['date', 'created_time', 'last_edited_time'].includes(svc.state.prop(cfg.categoryPropertyId ?? '')?.kind ?? '') && <Field label={t('Group dates by')}><Select value={cfg.dateBucket ?? 'month'} options={['day', 'week', 'month', 'year'].map((b) => ({ value: b, label: t(b[0].toUpperCase() + b.slice(1)) }))} onChange={(v) => set({ dateBucket: v as never })} /></Field>}
            <Field label={t('Split by')}><Select value={cfg.seriesPropertyId ?? ''} options={[{ value: '', label: t('None') }, ...axisOk.filter((p) => ['select', 'multi_select', 'status', 'people', 'checkbox'].includes(p.kind)).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ seriesPropertyId: v || null })} /></Field>
          </>
        )}
        <Field label={t('Measure')}>
          <Select value={measure.kind === 'count' ? 'count' : measure.propertyId} options={[{ value: 'count', label: t('Count of items') }, ...numeric.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ measure: v === 'count' ? { kind: 'count' } : { kind: 'agg', propertyId: v, op: 'sum' } })} />
        </Field>
        {measure.kind === 'agg' && <Field label={t('Calculate')}><Select value={measure.op} options={MEASURE_OPS.map((o) => ({ value: o, label: aggLabel(o) }))} onChange={(v) => set({ measure: { ...measure, op: v as never } })} /></Field>}
        {(cfg.type ?? 'bar_vertical') !== 'number' && <Field label={t('Order')}><Seg value={cfg.order ?? 'category'} onChange={(v) => set({ order: v })} options={[{ value: 'category', label: t('Natural') }, { value: 'value_desc', label: t('Largest first') }, { value: 'value_asc', label: t('Smallest first') }]} /></Field>}
        <Switch label={t('Hide “No value”')} on={!!cfg.hideEmpty} onChange={(v) => set({ hideEmpty: v })} />
        <span className="spacer" />
        <button type="button" className="db-tool" disabled={!svg} onClick={exportSvg}><Ic.Download size={13} /> SVG</button>
        <button type="button" className="db-tool" disabled={!svg} onClick={exportPng}><Ic.Image size={13} /> PNG</button>
      </div>
      {q.error && <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>}
      {result.error && <div className="db-error-box" role="alert">{result.error}</div>}
      {!req && !result.error && <div className="db-error-box"><b>{t('Choose what to chart')}</b><p>{t('Pick a property for the X axis, or switch to the Number chart.')}</p></div>}
      {result.data?.empty && <div className="db-empty"><b>{t('No data to chart')}</b><p>{t('No items match the filters of this view.')}</p></div>}
      {result.data && !result.data.empty && (
        <>
          {result.data.warnings.map((w) => <div key={w.code} className="db-date-hint" role="status">{w.detail}</div>)}
          {result.data.comparison && <div className="db-compare">{t('Compared with the previous period')}: <b dir="ltr">{result.data.comparison.delta !== null && result.data.comparison.delta > 0 ? '+' : ''}{result.data.comparison.delta ?? '—'}</b></div>}
          <div className="db-chart-svg" dangerouslySetInnerHTML={{ __html: svg }} onClick={(e) => { const el = (e.target as Element).closest('[data-cat]') as HTMLElement | null; if (el) setDrill({ cat: el.dataset.cat!, series: el.dataset.series && el.dataset.series !== '_' ? el.dataset.series : undefined }) }} />
        </>
      )}
      {drill && (
        <div className="db-drill" role="region" aria-label={t('Items in this bar')}>
          <div className="db-drill-head"><b>{drill.cat === NONE_GROUP ? t('No value') : t('Items')} <span className="db-count">{rowsFor.length}</span></b><button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setDrill(null)}><Ic.Close size={13} /></button></div>
          {rowsFor.map((id) => {
            const row = svc.state.row(id)
            return row ? <button key={id} type="button" className="db-listrow" onClick={() => nav.openRow(id, 'side')}><span dir="auto">{plainTitle(row.page.title)}</span>{measure.kind === 'agg' && svc.state.prop(measure.propertyId) && <span className="db-list-props"><CellView svc={svc} rs={ctl.rs} row={row} def={svc.state.prop(measure.propertyId)!} compact /></span>}</button> : null
          })}
          <div className="db-date-hint">{t('This list is read-only. Open an item to edit it.')}</div>
        </div>
      )}
    </div>
  )
}
