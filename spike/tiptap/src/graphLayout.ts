export const GRAPH_W = 1000
export const GRAPH_H = 640

export interface Pt {
  x: number
  y: number
}

/** Fruchterman–Reingold: linked pages attract, all pages repel. Deterministic start, so the picture is stable between opens. */
export function layout(ids: string[], edges: [string, string][]): Map<string, Pt> {
  const W = GRAPH_W
  const H = GRAPH_H
  const pos = ids.map((_, i) => ({ x: W / 2 + Math.cos(i * 2.399) * 20 * Math.sqrt(i + 1), y: H / 2 + Math.sin(i * 2.399) * 20 * Math.sqrt(i + 1) }))
  const index = new Map(ids.map((id, i) => [id, i]))
  const e = edges.map(([a, b]) => [index.get(a)!, index.get(b)!] as const)
  const k = Math.sqrt((W * H) / Math.max(ids.length, 1)) * 0.8
  const rounds = ids.length > 300 ? 70 : 180
  for (let it = 0; it < rounds; it++) {
    const cool = 1 - it / rounds
    const dx = ids.map(() => 0)
    const dy = ids.map(() => 0)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        let ax = pos[i].x - pos[j].x
        let ay = pos[i].y - pos[j].y
        const d2 = Math.max(ax * ax + ay * ay, 0.01)
        const f = (k * k) / d2
        ax *= f
        ay *= f
        dx[i] += ax; dy[i] += ay; dx[j] -= ax; dy[j] -= ay
      }
    for (const [a, b] of e) {
      const ax = pos[a].x - pos[b].x
      const ay = pos[a].y - pos[b].y
      const d = Math.max(Math.hypot(ax, ay), 0.01)
      const f = d / k
      dx[a] -= (ax / d) * d * f; dy[a] -= (ay / d) * d * f; dx[b] += (ax / d) * d * f; dy[b] += (ay / d) * d * f
    }
    for (let i = 0; i < ids.length; i++) {
      const d = Math.max(Math.hypot(dx[i], dy[i]), 0.01)
      const m = Math.min(d, 30 * cool + 1)
      pos[i].x = Math.min(W - 40, Math.max(40, pos[i].x + (dx[i] / d) * m + (W / 2 - pos[i].x) * 0.01))
      pos[i].y = Math.min(H - 40, Math.max(40, pos[i].y + (dy[i] / d) * m + (H / 2 - pos[i].y) * 0.01))
    }
  }
  return new Map(ids.map((id, i) => [id, pos[i]]))
}
