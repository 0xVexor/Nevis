// Chart view: the chart itself (an accessible SVG, also the export) with its settings beside it; a click on a bar opens a
// read-only list of exactly the rows it counts. The chart never writes anything.
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import { chartData, chartToSvg, drilldownFilter, type ChartRequest, type ChartTheme, type ChartType, type Measure } from '../query/chart.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { RollupAggregation } from '../props/config.ts'
import { download } from '../../backup'
import { Button, Dropdown, FormField, Icon, IconButton, Segmented, SwitchRow } from '../../design-system'
import { t } from '../../i18n'
import { CellView, useNav } from './CellView'
import { Hint, ViewMessage, errorText, plainTitle, rawOptions } from './common'
import { useViewQuery } from './useViewQuery'
import { aggKey } from './PropertyEditor'
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
const TYPES: { value: ChartType; label: string; icon: string }[] = [
  { value: 'bar_vertical', label: 'Bars', icon: 'chart-bar' },
  { value: 'bar_horizontal', label: 'Horizontal bars', icon: 'rows' },
  { value: 'line', label: 'Line', icon: 'chart-line' },
  { value: 'donut', label: 'Donut', icon: 'chart-pie' },
  { value: 'number', label: 'One number', icon: 'hash' },
]

// ── the chart's colours come from the design tokens, resolved to plain colours so the SVG export matches the screen

/** Changes whenever light / dark or the accent could have changed, so the chart is drawn again in the new colours. */
function themeSnapshot() {
  const root = document.documentElement
  return `${root.className}|${root.getAttribute('data-theme')}|${root.getAttribute('style')}|${matchMedia('(prefers-color-scheme: dark)').matches}`
}
function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  const mq = matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => {
    mo.disconnect()
    mq.removeEventListener('change', cb)
  }
}

/** Resolve CSS colour expressions (tokens, light-dark()) to #rrggbb through a probe element and a canvas. */
function resolveColors(exprs: string[]): string[] {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.append(probe)
  const g = document.createElement('canvas').getContext('2d')
  const out = exprs.map((e) => {
    probe.style.color = ''
    probe.style.color = e
    const css = getComputedStyle(probe).color
    if (!g) return css
    g.clearRect(0, 0, 1, 1)
    g.fillStyle = '#000'
    g.fillStyle = css
    g.fillRect(0, 0, 1, 1)
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
    return '#' + [r, gr, b].map((x) => x.toString(16).padStart(2, '0')).join('')
  })
  probe.style.fontFamily = 'var(--ds-font-ui)'
  const font = getComputedStyle(probe).fontFamily
  probe.remove()
  return [...out, font]
}

const OPTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
function chartTheme(): { theme: ChartTheme; option: Record<string, string> } {
  const slots = Array.from({ length: 8 }, (_, i) => `var(--ds-chart-${i + 1})`)
  const base = ['var(--ds-raised)', 'var(--ds-text)', 'var(--ds-text-2)', 'var(--ds-line-strong)', 'var(--ds-line)']
  const opts = OPTION_COLORS.map((c) => `var(--ds-opt-${c})`)
  const v = resolveColors([...slots, ...base, ...opts])
  const [surface, ink, muted, line, grid] = v.slice(8, 13)
  const option = Object.fromEntries(OPTION_COLORS.map((c, i) => [c, v[13 + i]]))
  return { theme: { palette: v.slice(0, 8), surface, ink, muted, line, grid, font: v[v.length - 1] }, option }
}

/** A select / status / multi-select axis keeps the colour each option has everywhere else; uncoloured options take a chart slot. */
function optionColors(def: Definition | undefined, option: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  const opts = (def?.config as { options?: { id: Id; color?: string }[] } | undefined)?.options
  if (!def || !['select', 'status', 'multi_select'].includes(def.kind) || !opts) return m
  for (const o of opts) if (o.color && option[o.color]) m.set(o.id, option[o.color])
  return m
}

export function ChartView({ svc, view, ctl }: ViewProps) {
  const cfg = ((view.configuration as { chart?: ChartCfg }).chart ?? {}) as ChartCfg
  const nav = useNav()
  const [drill, setDrill] = useState<{ cat: string; series?: string } | null>(null)
  const props = svc.state.props(view.sourceId!).filter((p) => svc.access().canReadProperty(svc.principalId, p))
  const axisOk = props.filter(
    (p) => !['button', 'files', 'unique_id', 'rollup', 'connected'].includes(p.kind) && !(p.kind === 'formula' && p.config && (p.config as { resultType?: string }).resultType?.startsWith('list')),
  )
  const numeric = props.filter((p) => p.kind === 'number' || p.kind === 'formula' || p.kind === 'checkbox')
  const set = (patch: Partial<ChartCfg>) => void ctl.patch({ chart: { ...cfg, ...patch } as unknown as Json })
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1 }) // only for the filter / error state
  const type = cfg.type ?? 'bar_vertical'
  const req: ChartRequest | null = useMemo(() => {
    if (type !== 'number' && !cfg.categoryPropertyId) return null
    return {
      sourceId: view.sourceId!,
      principalId: svc.principalId,
      now: svc.nowIso(),
      zone: svc.zone,
      type,
      categoryPropertyId: cfg.categoryPropertyId ?? undefined,
      dateBucket: cfg.dateBucket,
      seriesPropertyId: cfg.seriesPropertyId ?? undefined,
      measure: cfg.measure ?? { kind: 'count' },
      filter: q.filter,
      search: ctl.search,
      order: cfg.order,
      hideEmpty: cfg.hideEmpty,
      weekStart: svc.weekStart,
    }
  }, [cfg, type, view.sourceId, q.filter, ctl.search, svc, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => {
    if (!req) return { data: null, error: null as string | null }
    try {
      return { data: chartData(svc.state, req), error: null }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [req, svc]) // eslint-disable-line react-hooks/exhaustive-deps
  const themeKey = useSyncExternalStore(subscribeTheme, themeSnapshot)
  const look = useMemo(() => chartTheme(), [themeKey])
  const catDef = cfg.categoryPropertyId ? svc.state.prop(cfg.categoryPropertyId) : undefined
  const seriesDef = cfg.seriesPropertyId ? svc.state.prop(cfg.seriesPropertyId) : undefined
  // Draw at the size it is shown, so its text stays at the UI size in a narrow widget too (never a scaled-down picture).
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [boxW, setBoxW] = useState(0)
  useLayoutEffect(() => {
    if (!box) return
    const ro = new ResizeObserver(([e]) => setBoxW(Math.floor(e.contentRect.width)))
    ro.observe(box)
    return () => ro.disconnect()
  }, [box])
  const draw = useMemo(() => {
    const data = result.data
    if (!data) return null
    // with series the colour names the series, otherwise the category
    const colors = optionColors(data.series.length ? seriesDef : catDef, look.option)
    return (width: number, height: number) =>
      chartToSvg(data, {
        title: view.name,
        rtl: document.documentElement.dir === 'rtl',
        unassignedLabel: t('No value'),
        xTitle: cfg.xTitle,
        yTitle: cfg.yTitle,
        width,
        height,
        theme: look.theme,
        colorOf: (key) => colors.get(key),
      })
  }, [result.data, view.name, cfg.xTitle, cfg.yTitle, look, catDef, seriesDef])
  const w = Math.max(280, boxW || 760)
  const svg = useMemo(() => (draw ? draw(w, Math.round(Math.min(380, Math.max(220, w * 0.5)))) : ''), [draw, w])
  // the export is always the full-size chart, whatever the size on screen
  const exportFile = () => (draw ? draw(760, 380) : '')
  const rowsFor = useMemo(() => {
    if (!drill || !req) return []
    const f = drilldownFilter(svc.state, req, drill.cat, drill.series)
    try {
      return svc.query(view.sourceId!, { filter: f, limit: 200, search: ctl.search }).pageIds
    } catch {
      return []
    }
  }, [drill, req, svc, view.sourceId, ctl.search]) // eslint-disable-line react-hooks/exhaustive-deps
  const exportSvg = () => download(`${view.name}.svg`, new Blob([exportFile()], { type: 'image/svg+xml' }))
  const exportPng = () => {
    const url = URL.createObjectURL(new Blob([exportFile()], { type: 'image/svg+xml' }))
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
  const isDate = ['date', 'created_time', 'last_edited_time'].includes(svc.state.prop(cfg.categoryPropertyId ?? '')?.kind ?? '')
  const measureProp = measure.kind === 'agg' ? svc.state.prop(measure.propertyId) : undefined

  return (
    <div className="dv-chart" data-settings={ctl.canSchema || undefined}>
      <div className="dv-chart-main">
        <div className="dv-chart-stage">
          {q.error ? (
            <ViewMessage tone="bad" title={t('This view cannot be shown')}>
              {errorText(q.error.code, q.error.message)}
            </ViewMessage>
          ) : result.error ? (
            <ViewMessage tone="bad" title={t('This chart cannot be drawn')}>
              {result.error}
            </ViewMessage>
          ) : !req ? (
            <ViewMessage title={t('Choose what to chart')}>{t('Pick a property for the X axis, or switch to the Number chart.')}</ViewMessage>
          ) : result.data?.empty ? (
            <ViewMessage title={t('No data to chart')}>{t('No items match the filters of this view.')}</ViewMessage>
          ) : result.data ? (
            <>
              {result.data.warnings.map((w) => (
                <Hint key={w.code}>{w.detail}</Hint>
              ))}
              {result.data.comparison && (
                <p className="dv-text">
                  {t('Compared with the previous period')}:{' '}
                  <b dir="ltr">
                    {result.data.comparison.delta !== null && result.data.comparison.delta > 0 ? '+' : ''}
                    {result.data.comparison.delta ?? '—'}
                  </b>
                </p>
              )}
              <div
                ref={setBox}
                className="dv-chart-svg"
                dangerouslySetInnerHTML={{ __html: svg }}
                onClick={(e) => {
                  const el = (e.target as Element).closest('[data-cat]') as HTMLElement | null
                  if (el) setDrill({ cat: el.dataset.cat!, series: el.dataset.series && el.dataset.series !== '_' ? el.dataset.series : undefined })
                }}
              />
              <p className="dv-hint">{t('Click a bar or a slice to see the items in it.')}</p>
            </>
          ) : null}
        </div>
        {drill && (
          <section className="dv-drill" aria-label={t('Items in this bar')}>
            <header className="dv-section-head">
              <span>{drill.cat === NONE_GROUP ? t('No value') : t('Items in this bar')}</span>
              <span className="ds-badge">{rowsFor.length}</span>
              <IconButton label={t('Close')} onClick={() => setDrill(null)}>
                <Icon name="x" size={15} />
              </IconButton>
            </header>
            <div className="ds-list ds-list--framed">
              {rowsFor.map((id) => {
                const row = svc.state.row(id)
                return row ? (
                  <div key={id} className="ds-list-row dv-stretch">
                    <button type="button" className="dv-stretch-hit" aria-label={plainTitle(row.page.title) || t('Untitled')} onClick={() => nav.openRow(id, 'side')} />
                    <span className="dv-listrow-title">
                      <span dir="auto">{plainTitle(row.page.title)}</span>
                    </span>
                    {measureProp && (
                      <span className="dv-listrow-props">
                        <CellView svc={svc} rs={ctl.rs} row={row} def={measureProp} />
                      </span>
                    )}
                  </div>
                ) : null
              })}
            </div>
            <Hint>{t('This list is read-only. Open an item to edit it.')}</Hint>
          </section>
        )}
      </div>
      <aside className="dv-chart-side" aria-label={t('Chart settings')}>
        {ctl.canSchema && (
          <>
            <FormField label={t('Chart type')}>
              <div className="dv-layouts" role="radiogroup" aria-label={t('Chart type')}>
                {TYPES.map((o) => (
                  <button key={o.value} type="button" role="radio" aria-checked={o.value === type} className="dv-layout" onClick={() => set({ type: o.value })}>
                    <Icon name={o.icon} size={18} />
                    <span>{t(o.label)}</span>
                  </button>
                ))}
              </div>
            </FormField>
            {type !== 'number' && (
              <>
                <FormField label={t('X axis')}>
                  <Dropdown label={t('X axis')} placeholder={t('Choose…')} value={cfg.categoryPropertyId ?? ''} options={rawOptions(axisOk)} onChange={(v) => set({ categoryPropertyId: v || null })} />
                </FormField>
                {isDate && (
                  <FormField label={t('Group dates by')}>
                    <Segmented
                      label={t('Group dates by')}
                      value={cfg.dateBucket ?? 'month'}
                      options={(['day', 'week', 'month', 'year'] as const).map((b) => ({ value: b, label: t(b[0].toUpperCase() + b.slice(1)) }))}
                      onChange={(v) => set({ dateBucket: v })}
                    />
                  </FormField>
                )}
                <FormField label={t('Split by')}>
                  <Dropdown
                    label={t('Split by')}
                    value={cfg.seriesPropertyId ?? ''}
                    options={[{ value: '', label: 'None' }, ...rawOptions(axisOk.filter((p) => ['select', 'multi_select', 'status', 'people', 'checkbox'].includes(p.kind)))]}
                    onChange={(v) => set({ seriesPropertyId: v || null })}
                  />
                </FormField>
              </>
            )}
            <FormField label={t('Measure')}>
              <Dropdown
                label={t('Measure')}
                value={measure.kind === 'count' ? 'count' : measure.propertyId}
                options={[{ value: 'count', label: 'Count of items' }, ...rawOptions(numeric)]}
                onChange={(v) => set({ measure: v === 'count' ? { kind: 'count' } : { kind: 'agg', propertyId: v, op: 'sum' } })}
              />
            </FormField>
            {measure.kind === 'agg' && (
              <FormField label={t('Calculate')}>
                <Dropdown
                  label={t('Calculate')}
                  value={measure.op}
                  options={MEASURE_OPS.map((o) => ({ value: o, label: aggKey(o) }))}
                  onChange={(v) => set({ measure: { ...measure, op: v as never } })}
                />
              </FormField>
            )}
            {type !== 'number' && (
              <FormField label={t('Order')}>
                <Dropdown
                  label={t('Order')}
                  value={cfg.order ?? 'category'}
                  onChange={(v) => set({ order: v })}
                  options={[
                    { value: 'category', label: 'Natural' },
                    { value: 'value_desc', label: 'Largest first' },
                    { value: 'value_asc', label: 'Smallest first' },
                  ]}
                />
              </FormField>
            )}
            <SwitchRow label={t('Hide “No value”')} checked={!!cfg.hideEmpty} onChange={(v) => set({ hideEmpty: v })} />
          </>
        )}
        <div className="dv-chart-export">
          <Button size="sm" icon={<Icon name="download" size={15} />} disabled={!svg} onClick={exportSvg}>
            SVG
          </Button>
          <Button size="sm" icon={<Icon name="image" size={15} />} disabled={!svg} onClick={exportPng}>
            PNG
          </Button>
        </div>
      </aside>
    </div>
  )
}
