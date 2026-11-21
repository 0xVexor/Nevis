// The map of pages and the links between them, in the old app's frame (`gr`: a full-size stage with floating panels: find, the selected page, zoom,
// counts). The old one draws on a canvas with a layout worker; this draws SVG with a plain force layout (no worker): fine for hundreds of linked pages.
import { useMemo, useRef, useState } from 'react'
import { Button, IconButton, Icon, SearchField, Stats, dirOf } from '../ds'
import { normalizeForSearch as norm } from '@nevis/text-fa'
import { locale, t } from '../i18n'
import { go } from '../router'
import type { Workspace } from '../workspace'

const W = 900, H = 600

export function Graph({ ws }: { ws: Workspace }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  const num = (n: number) => n.toLocaleString(locale())
  const title = useMemo(() => new Map(ws.data.pages.map(p => [p.id, p.title || t('Untitled')])), [ws.data])
  const { nodes, edges, unlinked } = useMemo(() => {
    const edges = ws.search.edges()
    const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))]
    const pos = new Map(ids.map((id, i) => [id, { x: W / 2 + 220 * Math.cos((2 * Math.PI * i) / Math.max(1, ids.length)), y: H / 2 + 200 * Math.sin((2 * Math.PI * i) / Math.max(1, ids.length)), vx: 0, vy: 0 }]))
    for (let it = 0; it < Math.min(250, 30000 / Math.max(1, ids.length)); it++) {
      for (const a of ids) for (const b of ids) if (a < b) {
        const p = pos.get(a)!, q2 = pos.get(b)!
        const dx = p.x - q2.x, dy = p.y - q2.y, d2 = Math.max(80, dx * dx + dy * dy), f = 3000 / d2
        p.vx += dx * f * 0.02; p.vy += dy * f * 0.02; q2.vx -= dx * f * 0.02; q2.vy -= dy * f * 0.02
      }
      for (const e of edges) { const p = pos.get(e.from)!, q2 = pos.get(e.to)!; const dx = q2.x - p.x, dy = q2.y - p.y; p.vx += dx * 0.01; p.vy += dy * 0.01; q2.vx -= dx * 0.01; q2.vy -= dy * 0.01 }
      for (const p of pos.values()) { p.x = Math.min(W - 40, Math.max(40, p.x + p.vx)); p.y = Math.min(H - 30, Math.max(30, p.y + p.vy)); p.vx *= 0.6; p.vy *= 0.6 }
    }
    const deg = new Map<string, number>()
    for (const e of edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1) }
    const live = ws.data.pages.filter(p => !p.trashed && p.type !== 'database').length
    return { nodes: ids.map(id => ({ id, deg: deg.get(id) ?? 0, ...pos.get(id)! })), edges, unlinked: Math.max(0, live - ids.length) }
  }, [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const at = new Map(nodes.map(n => [n.id, n]))
  const words = norm(q).split(/\s+/).filter(Boolean)
  const matches = new Set(words.length ? nodes.filter(n => words.every(w => norm(title.get(n.id) ?? '').includes(w))).map(n => n.id) : [])
  const conn = sel ? { to: edges.filter(e => e.from === sel).map(e => e.to), from: edges.filter(e => e.to === sel).map(e => e.from) } : null
  const top = [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 8)
  const zoom = (f: number) => setView(v => ({ ...v, k: Math.min(4, Math.max(0.3, v.k * f)) }))
  const row = (id: string, extra?: React.ReactNode) => <button key={id} type="button" className="gr-row" dir="auto" onClick={() => setSel(id)}><span>{title.get(id)}</span>{extra}</button>
  if (!nodes.length) return (
    <div className="gr" role="region" aria-label={t('Graph')} data-testid="graph">
      <div className="gr-none"><div className="ds-empty ds-empty--framed" data-testid="graph-empty"><Icon name="graph" /><b>{t('No links yet')}</b><span>{t('Link pages with [[ or @ and they appear here, joined by their links.')}</span></div></div>
    </div>
  )
  return (
    <div className="gr" role="region" aria-label={t('Graph')} data-testid="graph">
      <div className="gr-stage">
        <svg className="gr-canvas" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Map of {n} pages and {m} links', { n: num(nodes.length), m: num(edges.length) })}
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY } }} onPointerUp={() => { drag.current = null }} onPointerLeave={() => { drag.current = null }}
          onPointerMove={e => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; drag.current = { x: e.clientX, y: e.clientY }; setView(v => ({ ...v, x: v.x + dx, y: v.y + dy })) }} onDoubleClick={() => setView({ k: 1, x: 0, y: 0 })}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e, i) => <line key={i} x1={at.get(e.from)!.x} y1={at.get(e.from)!.y} x2={at.get(e.to)!.x} y2={at.get(e.to)!.y} stroke="var(--ds-line-strong, currentColor)" opacity={sel && e.from !== sel && e.to !== sel ? 0.12 : 0.5} />)}
            {nodes.map(n => (
              <g key={n.id} data-testid="graph-node" tabIndex={0} role="button" style={{ cursor: 'pointer' }} onClick={() => setSel(n.id)} onDoubleClick={() => go({ name: 'page', id: n.id })} onKeyDown={e => { if (e.key === 'Enter') go({ name: 'page', id: n.id }) }}>
                <circle cx={n.x} cy={n.y} r={5 + Math.min(8, n.deg)} fill={n.id === sel ? 'var(--ds-accent)' : matches.has(n.id) ? 'var(--ds-warn, #e9a23b)' : 'var(--ds-accent-soft, var(--ds-accent))'} stroke="var(--ds-accent)" />
                {(k => k >= 0.8 || n.id === sel || matches.has(n.id))(view.k) && <text x={n.x} y={n.y - 11 - Math.min(8, n.deg)} textAnchor="middle" fontSize="11" fill="var(--ds-text)">{title.get(n.id)}</text>}
              </g>
            ))}
          </g>
        </svg>
        <div className="gr-panel gr-find">
          <SearchField className="gr-search" value={q} onChange={setQ} label={t('Find a page on the map')} placeholder={t('Find a page on the map')} clearLabel={t('Clear')} />
          {q.trim() && <div className="gr-found" role="list">{matches.size ? [...matches].slice(0, 8).map(id => row(id)) : <p className="gr-note">{t('No page with that name is on the map')}</p>}</div>}
        </div>
        <aside className="gr-panel gr-card" aria-label={sel ? title.get(sel) : t('Most connected')}>
          {sel && conn ? (
            <>
              <div className="gr-card-head" dir={dirOf(title.get(sel) ?? '')}><span className="gr-card-ic"><Icon name="file-text" /></span><span className="gr-card-title">{title.get(sel)}</span></div>
              <div className="gr-card-acts"><Button variant="primary" size="sm" icon={<Icon name="arrow-up-right" size={15} className="ds-flip" />} onClick={() => go({ name: 'page', id: sel })}>{t('Open page')}</Button></div>
              <div className="gr-lists">
                <h3 className="gr-card-sec">{t('Links to')}</h3>{conn.to.length ? conn.to.map(id => row(id)) : <p className="gr-note">{t('This page links to no other page')}</p>}
                <h3 className="gr-card-sec">{t('Linked from')}</h3>{conn.from.length ? conn.from.map(id => row(id)) : <p className="gr-note">{t('No page links here yet')}</p>}
              </div>
            </>
          ) : (
            <>
              <h3 className="gr-card-sec">{t('Most connected')}</h3>
              <div className="gr-lists">{top.map(n => row(n.id, <em>{num(n.deg)}</em>))}</div>
              <p className="gr-note">{t('Pick a page on the map to see what it links to and what links to it.')}</p>
            </>
          )}
        </aside>
        <div className="gr-panel gr-zoom">
          <IconButton label={t('Zoom out')} onClick={() => zoom(1 / 1.3)}><Icon name="minus" size={16} /></IconButton>
          <span className="gr-pct" aria-live="polite">{num(Math.round(view.k * 100))}%</span>
          <IconButton label={t('Zoom in')} onClick={() => zoom(1.3)}><Icon name="plus" size={16} /></IconButton>
          <IconButton label={t('Fit to screen')} onClick={() => setView({ k: 1, x: 0, y: 0 })}><Icon name="maximize" size={16} /></IconButton>
        </div>
        <Stats className="gr-panel gr-stats" label={t('Map')} items={[{ label: t(nodes.length === 1 ? 'page' : 'pages'), value: num(nodes.length) }, { label: t(edges.length === 1 ? 'link' : 'links'), value: num(edges.length) }, ...(unlinked > 0 ? [{ label: t('without links'), value: num(unlinked) }] : [])]} />
      </div>
    </div>
  )
}
