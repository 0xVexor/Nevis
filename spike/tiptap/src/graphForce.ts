export interface Layout {
  xy: Float32Array // x0, y0, x1, y1, … in node order
  w: number
  h: number
}

/**
 * Fruchterman–Reingold: linked pages attract, nearby pages repel. Repulsion only looks at the 3×3 grid cells around a node
 * (it fades with distance anyway), so the cost grows with the number of pages, not its square. The world grows with the
 * node count and the start is deterministic, so the picture is stable between opens.
 * `edges` is a flat list of node index pairs: [a0, b0, a1, b1, …].
 */
export function layoutGraph(n: number, edges: Int32Array | number[]): Layout {
  const side = Math.max(300, Math.sqrt(n) * 90)
  const W = side * 1.6
  const H = side
  const k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.9
  const cell = k * 2
  const cols = Math.ceil(W / cell) + 1
  const rows = Math.ceil(H / cell) + 1
  const px = new Float32Array(n)
  const py = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = i * 2.399 // golden angle
    const r = k * 0.6 * Math.sqrt(i + 1)
    px[i] = W / 2 + Math.cos(a) * r
    py[i] = H / 2 + Math.sin(a) * r
  }
  const dx = new Float32Array(n)
  const dy = new Float32Array(n)
  const head = new Int32Array(cols * rows)
  const next = new Int32Array(n)
  const rounds = n > 1200 ? 60 : n > 400 ? 100 : 160
  const reach2 = cell * cell
  const margin = k * 0.5

  for (let it = 0; it < rounds; it++) {
    const temp = (k * 3) * (1 - it / rounds) + 0.5
    head.fill(-1)
    for (let i = 0; i < n; i++) {
      const c = Math.min(rows - 1, Math.max(0, (py[i] / cell) | 0)) * cols + Math.min(cols - 1, Math.max(0, (px[i] / cell) | 0))
      next[i] = head[c]
      head[c] = i
    }
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (px[i] / cell) | 0))
      const cy = Math.min(rows - 1, Math.max(0, (py[i] / cell) | 0))
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(rows - 1, cy + 1); gy++)
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++)
          for (let j = head[gy * cols + gx]; j !== -1; j = next[j]) {
            if (j === i) continue
            const ax = px[i] - px[j]
            const ay = py[i] - py[j]
            const d2 = ax * ax + ay * ay
            if (d2 > reach2) continue
            const f = (k * k) / Math.max(d2, 0.01) // force k²/d along the unit vector (ax, ay)/d
            dx[i] += ax * f
            dy[i] += ay * f
          }
    }
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e]
      const b = edges[e + 1]
      const ax = px[a] - px[b]
      const ay = py[a] - py[b]
      const d = Math.max(Math.hypot(ax, ay), 0.01)
      const f = d / k // force d²/k along the unit vector
      dx[a] -= ax * f
      dy[a] -= ay * f
      dx[b] += ax * f
      dy[b] += ay * f
    }
    for (let i = 0; i < n; i++) {
      const gx = (W / 2 - px[i]) * 0.02 // a weak pull to the middle (force grows with distance) keeps unconnected clusters from drifting apart
      const gy = (H / 2 - py[i]) * 0.02
      const vx = dx[i] + gx
      const vy = dy[i] + gy
      const d = Math.max(Math.hypot(vx, vy), 0.01)
      const m = Math.min(d, temp)
      px[i] = Math.min(W - margin, Math.max(margin, px[i] + (vx / d) * m))
      py[i] = Math.min(H - margin, Math.max(margin, py[i] + (vy / d) * m))
    }
  }
  const xy = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) (xy[i * 2] = px[i], (xy[i * 2 + 1] = py[i]))
  return { xy, w: W, h: H }
}
