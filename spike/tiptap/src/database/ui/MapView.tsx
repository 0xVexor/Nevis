// Map view: pins of one Place property on a pannable / zoomable Web-Mercator canvas. No tile provider and no API key ship with the
// app: without one configured (Settings → Database) pins sit on a plain graticule. Coordinates typed by hand always work offline,
// addresses are never looked up automatically, and at most 100 pins are drawn (the rest is counted, not hidden silently).
import { useMemo, useRef, useState } from 'react'
import type { Id } from '../model/types.ts'
import { MAP_VISIBLE_LIMIT, mapModel } from '../viewLogic.ts'
import { Button, Icon, IconButton } from '../../design-system'
import { t } from '../../i18n'
import { CellView, useNav } from './CellView'
import { PopoverEditor } from './CellEditor'
import { Hint, ViewMessage, errorText, plainTitle } from './common'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'

export const MAP_KEY = 'not.db.map'
export type TileConfig = { template: string; attribution: string }
export function loadTileConfig(): TileConfig | null {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_KEY) ?? 'null') as TileConfig | null
    return v && /^https:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(v.template) ? v : null
  } catch {
    return null
  }
}

const W = 900
const H = 520
const mx = (lon: number) => (lon + 180) / 360
const my = (lat: number) => {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}

export function MapView({ svc, view, ctl }: ViewProps) {
  const nav = useNav()
  const placeId = (view.configuration as { placePropertyId?: Id }).placePropertyId
  const def = placeId ? svc.state.prop(placeId) : undefined
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 5000 })
  const model = useMemo(() => (def ? mapModel(svc.state, ctl.rs, q.matchIds, def.id) : null), [svc, def, q.matchIds, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const [vp, setVp] = useState({ cx: 0.5, cy: 0.5, z: 1 })
  const [sel, setSel] = useState<Id | null>(null)
  const [editRow, setEditRow] = useState<{ id: Id; rect: DOMRect } | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const tiles = loadTileConfig()
  if (!def) return <ViewMessage title={t('Choose a place property')}>{t('Open View settings and pick the Place property to show.')}</ViewMessage>
  if (q.error || !model)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {q.error ? errorText(q.error.code, q.error.message) : ''}
      </ViewMessage>
    )
  const world = 256 * 2 ** vp.z
  const toScreen = (lat: number, lon: number) => ({ x: W / 2 + (mx(lon) - vp.cx) * world, y: H / 2 + (my(lat) - vp.cy) * world })
  const zoom = (d: number) => setVp((v) => ({ ...v, z: Math.max(0, Math.min(18, v.z + d)) }))
  const fit = () => {
    if (!model.pins.length) return setVp({ cx: 0.5, cy: 0.5, z: 1 })
    const xs = model.pins.map((p) => mx(p.lon))
    const ys = model.pins.map((p) => my(p.lat))
    const [x1, x2, y1, y2] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const span = Math.max((x2 - x1) * 1.3, (y2 - y1) * 1.3 * (W / H), 1e-6)
    setVp({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, z: Math.max(0, Math.min(17, Math.log2(W / 256 / span))) })
  }
  const tileEls = (() => {
    if (!tiles) return null
    const z = Math.max(0, Math.min(18, Math.round(vp.z)))
    const n = 2 ** z
    const size = world / n
    const x0 = Math.floor((vp.cx - W / 2 / world) * n)
    const x1 = Math.floor((vp.cx + W / 2 / world) * n)
    const y0 = Math.max(0, Math.floor((vp.cy - H / 2 / world) * n))
    const y1 = Math.min(n - 1, Math.floor((vp.cy + H / 2 / world) * n))
    const out = []
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const wx = ((x % n) + n) % n
        out.push(
          <image
            key={`${x}/${y}`}
            href={tiles.template.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(y))}
            x={W / 2 + (x / n - vp.cx) * world}
            y={H / 2 + (y / n - vp.cy) * world}
            width={size + 0.5}
            height={size + 0.5}
            preserveAspectRatio="none"
          />,
        )
      }
    return out
  })()
  const grid = (() => {
    const step = vp.z > 8 ? 0.1 : vp.z > 5 ? 1 : vp.z > 3 ? 5 : vp.z > 1 ? 15 : 30
    const out = []
    for (let lon = -180; lon <= 180; lon += step) {
      const p = toScreen(0, lon)
      if (p.x > -2 && p.x < W + 2) out.push(<line key={'lo' + lon} x1={p.x} x2={p.x} y1={0} y2={H} className="dv-map-grid" />)
    }
    for (let lat = -80; lat <= 80; lat += step) {
      const p = toScreen(lat, 0)
      if (p.y > -2 && p.y < H + 2) out.push(<line key={'la' + lat} y1={p.y} y2={p.y} x1={0} x2={W} className="dv-map-grid" />)
    }
    return out
  })()
  const sp = model.pins.find((p) => p.pageId === sel)
  const selRow = sel ? svc.state.row(sel) : undefined
  return (
    <div className="dv-map">
      <header className="dv-period">
        <h3 className="dv-period-title">
          {t('{n} pins', { n: model.totalPins })}
          {model.truncated > 0 && <small className="dv-hint"> · {t('showing the first {n}', { n: MAP_VISIBLE_LIMIT })}</small>}
        </h3>
        <span className="dv-period-end">
          <Button size="sm" variant="ghost" icon={<Icon name="maximize" size={15} />} onClick={fit}>
            {t('Fit all pins')}
          </Button>
          <IconButton label={t('Zoom in')} onClick={() => zoom(1)}>
            <Icon name="zoom-in" size={16} />
          </IconButton>
          <IconButton label={t('Zoom out')} onClick={() => zoom(-1)}>
            <Icon name="zoom-out" size={16} />
          </IconButton>
        </span>
      </header>
      {!tiles && <Hint>{t('No map provider is set up, so pins are drawn on a plain grid. You can add one in Settings → Database (a tile URL and its attribution).')}</Hint>}
      <div className="dv-map-frame">
        <svg
          className="dv-map-canvas"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('Map of items')}
          tabIndex={0}
          onWheel={(e) => {
            e.preventDefault()
            zoom(-Math.sign(e.deltaY) * 0.5)
          }}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY }
            ;(e.currentTarget as SVGElement).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            const sc = W / (e.currentTarget as SVGElement).getBoundingClientRect().width
            setVp((v) => ({ ...v, cx: v.cx - ((e.clientX - drag.current!.x) * sc) / world, cy: Math.max(0.01, Math.min(0.99, v.cy - ((e.clientY - drag.current!.y) * sc) / world)) }))
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={(e) => {
            const d = 40 / world
            if (e.key === 'ArrowLeft') setVp({ ...vp, cx: vp.cx - d })
            if (e.key === 'ArrowRight') setVp({ ...vp, cx: vp.cx + d })
            if (e.key === 'ArrowUp') setVp({ ...vp, cy: vp.cy - d })
            if (e.key === 'ArrowDown') setVp({ ...vp, cy: vp.cy + d })
            if (e.code === 'Equal' || e.code === 'NumpadAdd') zoom(1)
            if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoom(-1)
          }}
        >
          <rect width={W} height={H} className="dv-map-bg" />
          {tileEls ?? grid}
          {model.pins.map((p) => {
            const s = toScreen(p.lat, p.lon)
            if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) return null
            return (
              <g
                key={p.pageId}
                className="dv-pin"
                data-on={sel === p.pageId || undefined}
                transform={`translate(${s.x},${s.y})`}
                role="button"
                tabIndex={0}
                aria-label={p.title || p.name}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSel(p.pageId)}
                onKeyDown={(e) => e.key === 'Enter' && setSel(p.pageId)}
              >
                <path d="M0 0c-6-9-9-12-9-17a9 9 0 1 1 18 0c0 5-3 8-9 17z" />
                <circle cy={-17} r={3.5} />
              </g>
            )
          })}
        </svg>
        {tiles && <div className="dv-map-attr">{tiles.attribution}</div>}
        {sp && selRow && (
          <div className="dv-map-card" role="dialog" aria-label={plainTitle(selRow.page.title)}>
            <header className="dv-map-card-head">
              <b dir="auto">{plainTitle(selRow.page.title)}</b>
              <IconButton label={t('Close')} onClick={() => setSel(null)}>
                <Icon name="x" size={15} />
              </IconButton>
            </header>
            <CellView svc={svc} rs={ctl.rs} row={selRow} def={def} />
            <div className="dv-map-card-acts">
              <Button size="sm" variant="ghost" disabled={!ctl.canEditRows} onClick={(e) => setEditRow({ id: sel!, rect: e.currentTarget.getBoundingClientRect() })}>
                {t('Edit location')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => nav.openRow(sel!, 'side')}>
                {t('Open')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {model.unplaced.length > 0 && (
        <section className="dv-tray" aria-label={t('Items without coordinates')}>
          <h3 className="dv-section-head">
            {t('Not on the map')}
            <span className="ds-badge">{model.unplaced.length}</span>
          </h3>
          <div className="dv-tray-list">
            {model.unplaced.slice(0, 60).map((id) => (
              <span key={id} className="dv-tray-item">
                <button type="button" className="dv-tray-open" dir="auto" onClick={() => nav.openRow(id, 'side')}>
                  {plainTitle(svc.state.pages.get(id)?.title)}
                </button>
                {ctl.canEditRows && (
                  <IconButton label={t('Set the location')} onClick={(e) => setEditRow({ id, rect: e.currentTarget.getBoundingClientRect() })}>
                    <Icon name="map" size={14} />
                  </IconButton>
                )}
              </span>
            ))}
          </div>
        </section>
      )}
      {editRow && svc.state.row(editRow.id) && <PopoverEditor svc={svc} row={svc.state.row(editRow.id)!} def={def} anchor={editRow.rect} onClose={() => setEditRow(null)} />}
    </div>
  )
}
