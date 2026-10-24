import { useEffect, useMemo, useRef, useState } from 'react'
import { repo } from './store'
import type { Page } from './repo'
import { GRAPH_H, GRAPH_W, layout } from './graphLayout'
import { toneOf } from './PageIcon'
import { normalizeFa } from './normalize'
import * as Ic from './icons'
import { t } from './i18n'

const MAX_ALL = 500 // nodes drawn in the whole-vault view (most connected first)
const LABEL_ZOOM = 1.25 // below this zoom only hovered / important labels show

interface N {
  id: string
  title: string
  x: number
  y: number
  deg: number
  tone: string
}

const radius = (deg: number) => 6 + Math.min(deg, 10) * 1.1
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** Map of how pages link to each other. Default: the current page and everything within two links; or the whole vault. */
export function GraphView({ currentId, onOpen, onClose }: { currentId?: string; onOpen: (id: string) => void; onClose: () => void }) {
  const g = useMemo(() => repo.linkGraph(), [])
  const [scope, setScope] = useState<'local' | 'all'>(currentId && g.edges.some(([a, b]) => a === currentId || b === currentId) ? 'local' : 'all')
  const [hover, setHover] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const { nodes, edges } = useMemo(() => {
    const deg = new Map<string, number>()
    const adj = new Map<string, Set<string>>()
    for (const [a, b] of g.edges) {
      deg.set(a, (deg.get(a) ?? 0) + 1)
      deg.set(b, (deg.get(b) ?? 0) + 1)
      ;(adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
      ;(adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a)
    }
    let keep: Set<string>
    if (scope === 'local' && currentId) {
      keep = new Set([currentId])
      let frontier = [currentId]
      for (let hop = 0; hop < 2; hop++) {
        const next: string[] = []
        for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n))
        frontier = next
      }
    } else {
      const linked = g.nodes.filter((p) => deg.has(p.id)).sort((a, b) => deg.get(b.id)! - deg.get(a.id)!)
      keep = new Set(linked.slice(0, MAX_ALL).map((p) => p.id))
    }
    const list = g.nodes.filter((p) => keep.has(p.id))
    const es = g.edges.filter(([a, b]) => keep.has(a) && keep.has(b))
    const pos = layout(list.map((p) => p.id), es)
    return { nodes: list.map((p: Page): N => ({ id: p.id, title: p.title || t('Untitled'), ...pos.get(p.id)!, deg: deg.get(p.id) ?? 0, tone: toneOf(p.id) })), edges: es }
  }, [g, scope, currentId])

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const q = normalizeFa(query.trim())
  const matches = useMemo(() => new Set(q ? nodes.filter((n) => normalizeFa(n.title).includes(q)).map((n) => n.id) : []), [nodes, q])
  const focus = hover
  const near = useMemo(() => {
    const s = new Set<string>()
    if (focus) for (const [a, b] of edges) (a === focus && s.add(b), b === focus && s.add(a))
    return s
  }, [focus, edges])
  const top = useMemo(() => [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 8), [nodes])
  const topIds = useMemo(() => new Set(top.slice(0, 5).map((n) => n.id)), [top])
  const hovered = focus ? byId.get(focus) : undefined

  // fit the picture to the stage whenever the node set changes
  const fit = () => setView({ x: 0, y: 0, k: 1 })
  useEffect(fit, [scope])

  /** Zoom keeping the point under (cx, cy) fixed. Coordinates are in viewBox units. */
  const zoomAt = (factor: number, cx = GRAPH_W / 2, cy = GRAPH_H / 2) =>
    setView((v) => {
      const k = clamp(v.k * factor, 0.35, 5)
      const r = k / v.k
      return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }
    })
  const toSvg = (clientX: number, clientY: number) => {
    const el = svg.current
    if (!el) return { x: GRAPH_W / 2, y: GRAPH_H / 2 }
    const p = el.createSVGPoint()
    p.x = clientX
    p.y = clientY
    const m = el.getScreenCTM()
    return m ? p.matrixTransform(m.inverse()) : { x: GRAPH_W / 2, y: GRAPH_H / 2 }
  }
  const unit = (px: number) => px / view.k // keep strokes and text a constant on-screen size

  const curve = (a: N, b: N) => {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const bend = 0.12
    return `M${a.x} ${a.y} Q${mx - dy * bend} ${my + dx * bend} ${b.x} ${b.y}`
  }

  return (
    <div className="overlay graph-overlay" onMouseDown={onClose}>
      <div className="gv" role="dialog" aria-modal="true" aria-label={t('Graph view')} onMouseDown={(e) => e.stopPropagation()}>
        <header className="gv-head">
          <span className="gv-logo"><Ic.Link size={20} /></span>
          <div className="gv-title">
            <b>{t('Graph view')}</b>
            <small>{t('Pages linked with [[ or @ appear here. Click a page to open it.')}</small>
          </div>
          <div className="segmented gv-scope">
            {currentId && <button className={scope === 'local' ? 'on' : ''} onClick={() => setScope('local')}>{t('Around this page')}</button>}
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{t('Whole vault')}</button>
          </div>
          <button className="icon-btn" title={t('Close  Esc')} onClick={onClose}><Ic.Close /></button>
        </header>

        {nodes.length === 0 ? (
          <div className="gv-empty">
            <span className="fc2-art"><Ic.Link size={34} /></span>
            <h3>{t('No links yet')}</h3>
            <p>{t('No links between pages yet. Link pages with [[ or @ to see them here.')}</p>
          </div>
        ) : (
          <div className="gv-stage">
            <svg
              ref={svg}
              className={'gv-svg' + (drag.current?.moved ? ' grabbing' : '')}
              viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
              onWheel={(e) => {
                const p = toSvg(e.clientX, e.clientY)
                zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y)
              }}
              onPointerDown={(e) => {
                ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
                drag.current = { x: e.clientX, y: e.clientY, moved: false }
              }}
              onPointerMove={(e) => {
                const d = drag.current
                if (!d) return
                const dx = e.clientX - d.x
                const dy = e.clientY - d.y
                if (!d.moved && Math.hypot(dx, dy) < 4) return
                d.moved = true
                const a = toSvg(d.x, d.y)
                const b = toSvg(e.clientX, e.clientY)
                drag.current = { x: e.clientX, y: e.clientY, moved: true }
                setView((v) => ({ ...v, x: v.x + (b.x - a.x), y: v.y + (b.y - a.y) }))
              }}
              onPointerUp={() => setTimeout(() => (drag.current = null), 0)}
              onPointerLeave={() => (drag.current = null)}
              onDoubleClick={fit}
            >
              <defs>
                <filter id="gv-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="5" />
                </filter>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {edges.map(([a, b]) => {
                  const p = byId.get(a)!
                  const r = byId.get(b)!
                  const on = focus === a || focus === b
                  const dim = (focus && !on) || (q && !(matches.has(a) || matches.has(b)))
                  return <path key={a + b} d={curve(p, r)} fill="none" stroke={on ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth={unit(on ? 2.2 : 1.2)} opacity={dim ? 0.15 : on ? 1 : 0.8} strokeLinecap="round" />
                })}
                {nodes.map((n) => {
                  const cur = n.id === currentId
                  const isHit = matches.has(n.id)
                  const dim = (focus && focus !== n.id && !near.has(n.id)) || (q && !isHit)
                  const r = radius(n.deg)
                  const showLabel = view.k >= LABEL_ZOOM || cur || isHit || focus === n.id || near.has(n.id) || topIds.has(n.id)
                  return (
                    <g
                      key={n.id}
                      className="gv-node"
                      opacity={dim ? 0.2 : 1}
                      onPointerEnter={() => setHover(n.id)}
                      onPointerLeave={() => setHover(null)}
                      onClick={() => !drag.current?.moved && (onClose(), onOpen(n.id))}
                    >
                      {(cur || isHit || focus === n.id) && <circle cx={n.x} cy={n.y} r={r + 7} fill={cur ? 'var(--accent)' : n.tone} opacity={0.45} filter="url(#gv-glow)" />}
                      <circle cx={n.x} cy={n.y} r={r} fill={n.tone} fillOpacity={0.2} stroke={cur ? 'var(--accent)' : n.tone} strokeWidth={unit(cur ? 3.2 : 2)} />
                      <circle cx={n.x} cy={n.y} r={Math.max(2.5, r * 0.42)} fill={cur ? 'var(--accent)' : n.tone} />
                      {showLabel && (
                        <text className="gv-label" x={n.x} y={n.y + r + unit(15)} textAnchor="middle" fontSize={unit(12.5)} fontWeight={cur || focus === n.id ? 700 : 500}>
                          {n.title.length > 24 ? n.title.slice(0, 23) + '…' : n.title}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>

            <div className="gv-tools gv-search">
              <Ic.Search size={15} />
              <input placeholder={t('Find a page…')} value={query} dir="auto" onChange={(e) => setQuery(e.target.value)} />
              {q && <span className="gv-hits">{matches.size}</span>}
            </div>

            <div className="gv-tools gv-zoom">
              <button title={t('Zoom in')} onClick={() => zoomAt(1.3)}><Ic.Plus size={16} /></button>
              <span className="gv-pct">{Math.round(view.k * 100)}%</span>
              <button title={t('Zoom out')} onClick={() => zoomAt(1 / 1.3)}><span className="gv-minus" /></button>
              <button title={t('Fit to screen  (double-click)')} onClick={fit}><Ic.SelectAll size={16} /></button>
            </div>

            <div className="gv-tools gv-stats">
              <span><b>{nodes.length}</b>{t('Pages')}</span>
              <span><b>{edges.length}</b>{t('Links')}</span>
            </div>

            <aside className="gv-top">
              <h4>{t('Most connected')}</h4>
              {top.map((n) => (
                <button key={n.id} className={n.id === focus ? 'on' : ''} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onClick={() => (onClose(), onOpen(n.id))}>
                  <i style={{ background: n.tone }} />
                  <span dir="auto">{n.title}</span>
                  <em>{n.deg}</em>
                </button>
              ))}
            </aside>

            {hovered && (
              <div className="gv-card">
                <i style={{ background: hovered.tone }} />
                <div>
                  <b dir="auto">{hovered.title}</b>
                  <small>{t('{n} links', { n: hovered.deg })}</small>
                </div>
                <span>{t('Click to open')}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
