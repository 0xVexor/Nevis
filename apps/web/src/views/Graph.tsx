import { t } from '../i18n'
import { Screen } from '../ds'
import { useMemo } from 'react'
import { go } from '../router'
import type { Workspace } from '../workspace'

/** The links between pages (derived from the pages' `[[` links). A small force layout, computed once per change; no library. */
export function Graph({ ws }: { ws: Workspace }) {
  const { nodes, edges } = useMemo(() => {
    const edges = ws.search.edges()
    const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))]
    const title = new Map(ws.data.pages.map(p => [p.id, p.title || 'بدون عنوان']))
    const W = 640, H = 420
    const pos = new Map(ids.map((id, i) => [id, { x: W / 2 + 160 * Math.cos((2 * Math.PI * i) / Math.max(1, ids.length)), y: H / 2 + 140 * Math.sin((2 * Math.PI * i) / Math.max(1, ids.length)), vx: 0, vy: 0 }]))
    for (let it = 0; it < 200; it++) {
      for (const a of ids) for (const b of ids) if (a < b) {
        const p = pos.get(a)!, q = pos.get(b)!
        const dx = p.x - q.x, dy = p.y - q.y, d2 = Math.max(80, dx * dx + dy * dy), f = 2500 / d2
        p.vx += dx * f * 0.02; p.vy += dy * f * 0.02; q.vx -= dx * f * 0.02; q.vy -= dy * f * 0.02
      }
      for (const e of edges) {
        const p = pos.get(e.from)!, q = pos.get(e.to)!
        const dx = q.x - p.x, dy = q.y - p.y
        p.vx += dx * 0.01; p.vy += dy * 0.01; q.vx -= dx * 0.01; q.vy -= dy * 0.01
      }
      for (const p of pos.values()) { p.x = Math.min(W - 40, Math.max(40, p.x + p.vx)); p.y = Math.min(H - 20, Math.max(20, p.y + p.vy)); p.vx *= 0.6; p.vy *= 0.6 }
    }
    return { nodes: ids.map(id => ({ id, title: title.get(id) ?? '', ...pos.get(id)! })), edges }
  }, [ws.data, ws.search.ready])
  const at = new Map(nodes.map(n => [n.id, n]))
  return (
    <Screen title={t('Graph')} width="wide"><div data-testid="graph" dir="rtl">
      {!nodes.length ? <p data-testid="graph-empty">هنوز پیوندی بین صفحه‌ها نیست. با «[[» از یک صفحه به صفحهٔ دیگر پیوند بدهید.</p> : (
        <svg viewBox="0 0 640 420" width="100%" role="img" aria-label="گراف صفحه‌ها" style={{ maxWidth: 800, background: 'var(--ds-surface, transparent)' }}>
          {edges.map((e, i) => <line key={i} x1={at.get(e.from)!.x} y1={at.get(e.from)!.y} x2={at.get(e.to)!.x} y2={at.get(e.to)!.y} stroke="currentColor" opacity=".35" />)}
          {nodes.map(n => (
            <g key={n.id} data-testid="graph-node" tabIndex={0} role="link" style={{ cursor: 'pointer' }} onClick={() => go({ name: 'page', id: n.id })} onKeyDown={e => { if (e.key === 'Enter') go({ name: 'page', id: n.id }) }}>
              <circle cx={n.x} cy={n.y} r={7} fill="var(--ds-accent, #087f74)" />
              <text x={n.x} y={n.y - 11} textAnchor="middle" fontSize="12" fill="currentColor">{n.title}</text>
            </g>
          ))}
        </svg>
      )}
    </div></Screen>
  )
}
