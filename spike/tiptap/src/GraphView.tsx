import { commandMatches } from './shortcutCommands'
import { PageIcon } from './PageIcon'
import { dirOf, Button, ChipButton, Icon, IconButton, SearchField, Stats, Tag } from './design-system'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getDatabase } from './database/runtime'
import { useDatabaseEdges, EdgeKindToggles, type ExtraKinds } from './database/ui/GraphEdges'
import { repo } from './store'
import { layoutAsync } from './graphLayout'
import { normalizeFa } from './normalize'
import { t, locale } from './i18n'

const MAX_ALL = 3000 // nodes drawn in the whole-vault view (most connected first)
const LABEL_ZOOM = 1.25 // above this zoom (1 = fitted) every visible label shows, up to MAX_LABELS
const MAX_LABELS = 250
const MIN_Z = 0.35
const MAX_Z = 12

interface N {
  id: string
  title: string
  x: number
  y: number
  deg: number
}

interface Scene {
  nodes: N[]
  edges: Int32Array // index pairs into nodes
  byId: Map<string, number>
  w: number
  h: number
  gap: number // typical distance between neighbouring pages, in world units
  adj: { off: Int32Array; nb: Int32Array } // neighbours of page i: nb[off[i] .. off[i + 1]]
}

interface View {
  x: number
  y: number
  k: number // screen px per world unit
}

const NO_NODES: N[] = []
const NO_SET = new Set<number>()
const LINE_BUDGET = 1_500_000 // px of link (|dx| + |dy| summed) drawn per full repaint before evenly spread links start being skipped; the repaint cost grows with it
let quiet = new Float32Array(0) // scratch for the links of one repaint
const VARS = ['--ds-accent', '--ds-line-strong', '--ds-text', '--ds-text-2', '--ds-text-3', '--ds-bg'] as const
let palette: { key: string; at: number; c: Record<(typeof VARS)[number], string>; font: string } | null = null

/** Theme colours as plain rgb() strings (the canvas does not understand light-dark() or color-mix() that the stylesheet uses) and the font; looked up at most twice a second, not on every frame. */
function colors(host: HTMLElement) {
  const now = performance.now()
  if (palette && now - palette.at < 500) return palette
  const key = `${document.documentElement.dataset.theme ?? ''}|${getComputedStyle(document.body).colorScheme}|${matchMedia('(prefers-color-scheme: dark)').matches}`
  if (palette?.key === key) return ((palette.at = now), palette)
  const probe = document.createElement('i')
  host.append(probe)
  const c = {} as Record<(typeof VARS)[number], string>
  for (const v of VARS) {
    probe.style.color = `var(${v})`
    c[v] = getComputedStyle(probe).color
  }
  probe.remove()
  palette = { key, at: now, c, font: getComputedStyle(host).fontFamily }
  return palette
}

const LABEL_BASE = 17 // baseline of the text inside a label bitmap, px from its top
const sprites = new Map<string, { cv: HTMLCanvasElement; w: number; h: number }>()
let measure: CanvasRenderingContext2D | null = null

/** A page title drawn with its outline, cached: the same labels come back on every repaint while zooming and panning. */
function labelSprite(label: string, bold: boolean, text: string, halo: string, font: string, dpr: number) {
  const key = `${bold ? 1 : 0}|${dpr}|${text}|${halo}|${label}`
  const hit = sprites.get(key)
  if (hit) return hit
  const css = `${bold ? 600 : 500} 12px ${font}`
  measure ??= document.createElement('canvas').getContext('2d')!
  measure.font = css
  const w = Math.ceil(measure.measureText(label).width) + 10
  const h = 24
  const cv = document.createElement('canvas')
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  const c = cv.getContext('2d')!
  c.scale(dpr, dpr)
  c.font = css
  c.textAlign = 'center'
  c.lineJoin = 'round'
  c.lineWidth = 4
  c.strokeStyle = halo
  c.strokeText(label, w / 2, LABEL_BASE)
  c.fillStyle = text
  c.fillText(label, w / 2, LABEL_BASE)
  const sp = { cv, w, h }
  sprites.set(key, sp)
  if (sprites.size > 800) sprites.delete(sprites.keys().next().value!)
  return sp
}

/** A page's dot grows with its links, quickly at first and then slowly, so hubs stand out without swallowing their neighbours. */
const baseRadius = (deg: number) => 3.5 + Math.sqrt(Math.min(deg, 40)) * 1.6
/** Dots shrink when pages are packed close on screen and grow as you zoom in, so a big vault does not turn into one blob. */
const radiusScale = (s: Scene, k: number) => clamp((s.gap * k) / 26, 0.3, 1.25)
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/**
 * Map of how pages link to each other. Default: the current page and everything within two links; or the whole vault.
 * Drawn on one canvas: panning, zooming and hovering repaint the picture without going through React, so the map
 * stays smooth with thousands of pages. The layout is computed in a worker.
 */
export function GraphView({ currentId, onOpen, onClose }: { currentId?: string; onOpen: (id: string) => void; onClose: () => void }) {
  // the database service starts on demand; the typed links (relations, dependencies, sub-items) need it, so start it with the graph
  const [, setDbReady] = useState(false)
  useEffect(
    () =>
      void getDatabase()
        .then(() => setDbReady(true))
        .catch(() => undefined),
    [],
  )
  const [kinds, setKinds] = useState<ExtraKinds>({ relation: false, dependency: false, hierarchy: false })
  const extra = useDatabaseEdges(kinds)
  const links = useMemo(() => repo.linkGraph(), [])
  const g = useMemo(() => (extra.length ? { nodes: links.nodes, edges: [...links.edges, ...extra] as [string, string][] } : links), [links, extra])
  const [scope, setScope] = useState<'local' | 'all'>(currentId && g.edges.some(([a, b]) => a === currentId || b === currentId) ? 'local' : 'all')
  // the page "Around this page" is centred on: the open page at first, any page you explore from afterwards
  const [root, setRoot] = useState<string | null>(currentId ?? null)
  const [depth, setDepth] = useState<1 | 2 | 3>(2)
  const [tag, setTag] = useState<string | null>(null) // pages with this tag stay lit, the rest dim
  const [hover, setHover] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null) // the page picked on the map: it stays lit and gets the card on the side
  const [query, setQuery] = useState('')
  const [pct, setPct] = useState(100)
  const [scene, setScene] = useState<Scene | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const base = useRef(1) // k when the picture is fitted to the stage
  const size = useRef({ w: 1, h: 1 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const moved = useRef(false) // the user has panned or zoomed, so a resize must not snap the picture back to fit
  const target = useRef<View>({ x: 0, y: 0, k: 1 }) // where the view is gliding to: zoom and fit are eased, not jumped
  const glideFrame = useRef(0)
  const touchedAt = useRef(0) // last time the view moved
  const settle = useRef(0)
  // The page under the pointer, kept outside React state so hovering repaints at once (null = use the state, e.g. a hover in the side list).
  const hoverRef = useRef<{ idx: number; near: Set<number> } | null>(null)

  // Escape lets go of the picked page first, then leaves; F fits, + and − zoom (physical keys, any keyboard language)
  const keys = useRef<{ fit: () => void; zoom: (f: number) => void }>({ fit: () => {}, zoom: () => {} })
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (commandMatches(e, 'Close graph')) {
        e.preventDefault()
        return sel ? setSel(null) : onClose()
      }
      const target = e.target as HTMLElement
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (commandMatches(e, 'Fit graph')) (e.preventDefault(), keys.current.fit())
      else if (commandMatches(e, 'Zoom graph in')) (e.preventDefault(), keys.current.zoom(1.3))
      else if (commandMatches(e, 'Zoom graph out')) (e.preventDefault(), keys.current.zoom(1 / 1.3))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, sel])

  // which pages are drawn
  const picked = useMemo(() => {
    const deg = new Map<string, number>()
    const adj = new Map<string, Set<string>>()
    for (const [a, b] of g.edges) {
      deg.set(a, (deg.get(a) ?? 0) + 1)
      deg.set(b, (deg.get(b) ?? 0) + 1)
      ;(adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
      ;(adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a)
    }
    let keep: Set<string>
    const from = root ?? currentId
    if (scope === 'local' && from) {
      keep = new Set([from])
      let frontier = [from]
      for (let hop = 0; hop < depth; hop++) {
        const next: string[] = []
        for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n))
        frontier = next
      }
    } else {
      const linked = g.nodes.filter((p) => deg.has(p.id)).sort((a, b) => deg.get(b.id)! - deg.get(a.id)!)
      keep = new Set(linked.slice(0, MAX_ALL).map((p) => p.id))
    }
    return { pages: g.nodes.filter((p) => keep.has(p.id)), edges: g.edges.filter(([a, b]) => keep.has(a) && keep.has(b)), deg, unlinked: g.nodes.length - deg.size }
  }, [g, scope, currentId, root, depth])

  // lay them out (off the main thread), then fit the picture to the stage
  useEffect(() => {
    let live = true
    setScene(null)
    hoverRef.current = null
    const { edges, deg } = picked
    // canonical order (by id), so the same vault always gives the same picture, whatever order the pages were read in: that is what lets it be cached
    const pages = [...picked.pages].sort((a, b) => (a.id < b.id ? -1 : 1))
    const byId = new Map(pages.map((p, i) => [p.id, i]))
    const idx = edges.map(([a, b]) => [byId.get(a)!, byId.get(b)!] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1])
    const pairs = new Int32Array(idx.length * 2)
    idx.forEach(([a, b], i) => ((pairs[i * 2] = a), (pairs[i * 2 + 1] = b)))
    void layoutAsync(pages.length, pairs).then((l) => {
      if (!live) return
      const nodes = pages.map((p, i): N => ({ id: p.id, title: p.title || t('Untitled'), x: l.xy[i * 2], y: l.xy[i * 2 + 1], deg: deg.get(p.id) ?? 0 }))
      const off = new Int32Array(pages.length + 1)
      for (let e = 0; e < pairs.length; e++) off[pairs[e] + 1]++
      for (let i = 0; i < pages.length; i++) off[i + 1] += off[i]
      const at = off.slice(0, pages.length)
      const nb = new Int32Array(pairs.length)
      for (let e = 0; e < pairs.length; e += 2) {
        nb[at[pairs[e]]++] = pairs[e + 1]
        nb[at[pairs[e + 1]]++] = pairs[e]
      }
      setScene({ nodes, edges: pairs, byId, w: l.w, h: l.h, gap: Math.sqrt((l.w * l.h) / Math.max(pages.length, 1)) * 0.9, adj: { off, nb } })
    })
    return () => void (live = false)
  }, [picked])

  const nodes = scene?.nodes ?? NO_NODES
  const q = normalizeFa(query.trim())
  // the pages that stay lit: those whose title has the search words and, with a tag picked, carry that tag
  const tagged = useMemo(() => (tag ? new Set(nodes.flatMap((n, i) => ((repo.get(n.id)?.tags ?? []).some((x) => normalizeFa(x) === normalizeFa(tag)) ? [i] : []))) : null), [nodes, tag])
  const matches = useMemo(
    () => new Set(q || tagged ? nodes.flatMap((n, i) => ((!q || normalizeFa(n.title).includes(q)) && (!tagged || tagged.has(i)) ? [i] : [])) : []),
    [nodes, q, tagged],
  )
  const filtering = q || (tag ? '#' + tag : '')
  const focusIdx = hover != null || sel != null ? (scene?.byId.get((hover ?? sel)!) ?? -1) : -1
  // neighbours straight from the adjacency index, not a scan of every link
  const near = useMemo(() => {
    const s = new Set<number>()
    if (!scene || focusIdx < 0) return s
    for (let k = scene.adj.off[focusIdx]; k < scene.adj.off[focusIdx + 1]; k++) s.add(scene.adj.nb[k])
    return s
  }, [scene, focusIdx])
  // tags of the drawn pages, most used first: the chips that filter the map
  const tags = useMemo(() => {
    const count = new Map<string, number>()
    for (const n of nodes) for (const x of repo.get(n.id)?.tags ?? []) count.set(x, (count.get(x) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([x]) => x)
  }, [nodes])
  const top = useMemo(() => [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 8), [nodes])
  const topIdx = useMemo(() => new Set(top.slice(0, 5).map((n) => scene?.byId.get(n.id) ?? -1)), [top, scene])
  const curIdx = currentId && scene ? (scene.byId.get(currentId) ?? -1) : -1
  const hovered = focusIdx >= 0 ? nodes[focusIdx] : undefined
  const selIdx = sel != null ? (scene?.byId.get(sel) ?? -1) : -1
  const selNode = selIdx >= 0 ? nodes[selIdx] : undefined
  const selPage = selNode ? repo.get(selNode.id) : undefined
  // the picked page's links in both directions: the pages it links to, and the pages that link to it
  const conn = useMemo(() => {
    const to: N[] = []
    const from: N[] = []
    if (!scene || selIdx < 0) return { to, from }
    const e = scene.edges
    for (let i = 0; i < e.length; i += 2) {
      if (e[i] === selIdx && e[i + 1] !== selIdx) to.push(scene.nodes[e[i + 1]])
      else if (e[i + 1] === selIdx) from.push(scene.nodes[e[i]])
    }
    const byTitle = (a: N, b: N) => a.title.localeCompare(b.title)
    return { to: to.sort(byTitle), from: from.sort(byTitle) }
  }, [scene, selIdx])

  // everything the painter needs, so it can run from animation frames without React
  const paintInput = useRef({ scene, focusIdx, near, matches, topIdx, curIdx, q: filtering })
  paintInput.current = { scene, focusIdx, near, matches, topIdx, curIdx, q: filtering }

  type Input = typeof paintInput.current
  // The map drawn once at rest, with a margin around the screen (so panning has something to show), and the view it was drawn for.
  const layer = useRef<{ cv: HTMLCanvasElement; key: string; scene: Scene; lv: View; mx: number; my: number; dpr: number } | null>(null)

  /**
   * Draws the map. `overlay` = only the page under the pointer, its neighbours and the links between them, on top of what is already
   * there (hovering must not redraw thousands of links); `moving` = cheaper strokes while panning/zooming.
   */
  const drawScene = useCallback((ctx: CanvasRenderingContext2D, input: Input, moving: boolean, overlay: boolean, frame?: { v: View; W: number; H: number }) => {
    const cv = canvas.current!
    const { scene, focusIdx, near, matches, topIdx, curIdx, q } = input
    if (!scene) return
    const dpr = window.devicePixelRatio || 1
    const W = frame?.W ?? size.current.w
    const H = frame?.H ?? size.current.h
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!overlay) ctx.clearRect(0, 0, W, H)
    const pal = colors(cv.parentElement!)
    // one accent for what you are looking at (the open page, the picked one, its links, what search or a tag lights); the rest is ink
    const accent = pal.c['--ds-accent']
    const line = pal.c['--ds-line-strong']
    const text = pal.c['--ds-text']
    const ink = pal.c['--ds-text-2']
    const quietInk = pal.c['--ds-text-3']
    const halo = pal.c['--ds-bg'] // the stage's own colour: a ring of it around dots and labels cuts the links that pass under them
    const v = frame?.v ?? view.current
    const z = v.k / base.current
    const grow = radiusScale(scene, v.k)
    const { nodes, edges } = scene
    const sx = (n: N) => v.x + n.x * v.k
    const sy = (n: N) => v.y + n.y * v.k
    const inView = (x: number, y: number, pad = 40) => x > -pad && y > -pad && x < W + pad && y < H + pad
    const dimming = focusIdx >= 0 || !!q
    const lit = (i: number) => (focusIdx >= 0 ? i === focusIdx || near.has(i) : !q || matches.has(i))

    // edges: all the quiet ones in one stroke, the highlighted ones on top. Rasterising thousands of links is the expensive part
    // of a frame, so with many of them they are straight (the curve is not visible at that density) and have flat ends.
    const straight = edges.length / 2 > 2500
    // A link that leaves the screen is cut at its edge: rasterising a line thousands of pixels long (zoomed in) is what made the repaint slow.
    const seg = [0, 0, 0, 0]
    const clip = (ax: number, ay: number, bx: number, by: number) => {
      const pad = 20
      const dx = bx - ax,
        dy = by - ay
      let t0 = 0,
        t1 = 1
      const P = [-dx, dx, -dy, dy]
      const Q = [ax + pad, W + pad - ax, ay + pad, H + pad - ay]
      for (let i = 0; i < 4; i++) {
        if (P[i] === 0) {
          if (Q[i] < 0) return false
        } else {
          const r = Q[i] / P[i]
          if (P[i] < 0) {
            if (r > t1) return false
            if (r > t0) t0 = r
          } else {
            if (r < t0) return false
            if (r < t1) t1 = r
          }
        }
      }
      seg[0] = ax + t0 * dx
      seg[1] = ay + t0 * dy
      seg[2] = ax + t1 * dx
      seg[3] = ay + t1 * dy
      return true
    }
    const link = (ax: number, ay: number, bx: number, by: number, curved: boolean) => {
      if (inView(ax, ay, 20) && inView(bx, by, 20)) {
        ctx.moveTo(ax, ay)
        if (curved) ctx.quadraticCurveTo((ax + bx) / 2 - (by - ay) * 0.12, (ay + by) / 2 + (bx - ax) * 0.12, bx, by)
        else ctx.lineTo(bx, by)
      } else if (clip(ax, ay, bx, by)) {
        ctx.moveTo(seg[0], seg[1])
        ctx.lineTo(seg[2], seg[3])
      }
    }
    // The quiet links are collected first (x1, y1, x2, y2, whole?) so that, when the visible ones add up to more line than is worth
    // rasterising, evenly spread ones are skipped: zoomed in, thousands of long links overlap anyway.
    const hot: number[] = []
    const need = (edges.length / 2) * 5
    if (quiet.length < need) quiet = new Float32Array(need)
    let nq = 0
    let drawn = 0
    for (let e = 0; e < edges.length; e += 2) {
      const a = nodes[edges[e]]
      const b = nodes[edges[e + 1]]
      const ax = sx(a),
        ay = sy(a),
        bx = sx(b),
        by = sy(b)
      const on = focusIdx >= 0 ? edges[e] === focusIdx || edges[e + 1] === focusIdx : q ? matches.has(edges[e]) || matches.has(edges[e + 1]) : false
      if (overlay && !on) continue
      if (on) {
        hot.push(e)
        continue
      }
      const o = nq * 5
      if (inView(ax, ay, 20) && inView(bx, by, 20)) {
        quiet[o] = ax
        quiet[o + 1] = ay
        quiet[o + 2] = bx
        quiet[o + 3] = by
        quiet[o + 4] = 1
      } else if (clip(ax, ay, bx, by)) {
        quiet[o] = seg[0]
        quiet[o + 1] = seg[1]
        quiet[o + 2] = seg[2]
        quiet[o + 3] = seg[3]
        quiet[o + 4] = 0
      } else continue
      drawn += Math.abs(quiet[o + 2] - quiet[o]) + Math.abs(quiet[o + 3] - quiet[o + 1])
      nq++
    }
    // links are straight hairlines: calmer than curves, and the cheapest thing to rasterise
    const stride = drawn > LINE_BUDGET ? Math.ceil(drawn / LINE_BUDGET) : 1
    ctx.beginPath()
    for (let i = 0; i < nq; i += stride) {
      const o = i * 5
      ctx.moveTo(quiet[o], quiet[o + 1])
      ctx.lineTo(quiet[o + 2], quiet[o + 3])
    }
    ctx.strokeStyle = line
    ctx.lineWidth = straight ? 0.8 : 1
    ctx.lineCap = 'butt'
    ctx.globalAlpha = dimming ? 0.12 : 0.9
    ctx.stroke()
    if (hot.length) {
      ctx.beginPath()
      for (const e of hot) {
        const a = nodes[edges[e]]
        const b = nodes[edges[e + 1]]
        link(sx(a), sy(a), sx(b), sy(b), false)
      }
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 1
      ctx.stroke()
      // around the picked page each link shows its direction: a small arrowhead where it arrives
      if (focusIdx >= 0) {
        ctx.beginPath()
        for (const e of hot) {
          const a = nodes[edges[e]]
          const b = nodes[edges[e + 1]]
          const ax = sx(a),
            ay = sy(a),
            bx = sx(b),
            by = sy(b)
          const len = Math.hypot(bx - ax, by - ay)
          if (len < 24 || !inView(bx, by)) continue
          const ux = (bx - ax) / len,
            uy = (by - ay) / len
          const tip = baseRadius(b.deg) * grow + 3
          const px = bx - ux * tip,
            py = by - uy * tip
          ctx.moveTo(px, py)
          ctx.lineTo(px - ux * 7 - uy * 3.5, py - uy * 7 + ux * 3.5)
          ctx.lineTo(px - ux * 7 + uy * 3.5, py - uy * 7 - ux * 3.5)
          ctx.closePath()
        }
        ctx.fillStyle = accent
        ctx.fill()
      }
    }

    // nodes
    const labels: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const x = sx(n),
        y = sy(n)
      if (!inView(x, y)) continue
      if (overlay && i !== focusIdx && !near.has(i)) continue
      const cur = i === curIdx
      const focus = i === focusIdx
      const r = baseRadius(n.deg) * grow
      const bright = lit(i)
      ctx.globalAlpha = dimming && !bright ? 0.18 : 1
      // a solid dot with a ring of the stage colour, so the links that end under it stop cleanly at its edge
      ctx.beginPath()
      ctx.arc(x, y, r + 2, 0, 6.2832)
      ctx.fillStyle = halo
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 6.2832)
      // the accent marks what you are looking at; neighbours of it are full ink, hubs a shade darker than the rest
      ctx.fillStyle = cur || focus || (matches.has(i) && dimming) ? accent : near.has(i) ? text : topIdx.has(i) ? ink : quietInk
      ctx.fill()
      // the picked page and the open page carry a thin target ring, so they read at a glance without a glow
      if ((focus || cur) && !moving) {
        ctx.beginPath()
        ctx.arc(x, y, r + 5, 0, 6.2832)
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      if (cur || matches.has(i) || i === focusIdx || near.has(i) || topIdx.has(i)) labels.push(i)
      else if (z >= LABEL_ZOOM && !moving && labels.length < MAX_LABELS) labels.push(i)
    }

    // labels (each one is drawn once into a small bitmap and then only copied: outlined text is slow to rasterise)
    for (const i of labels) {
      const n = nodes[i]
      const bold = i === curIdx || i === focusIdx
      ctx.globalAlpha = dimming && !lit(i) ? 0.18 : 1
      const label = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title
      // the picked, open and hub pages in full ink, the rest a step quieter; each label is cut out of the links under it
      const sp = labelSprite(label, bold, bold || topIdx.has(i) || near.has(i) ? text : ink, halo, pal.font, dpr)
      ctx.drawImage(sp.cv, sx(n) - sp.w / 2, sy(n) + baseRadius(n.deg) * grow + 17 - LABEL_BASE, sp.w, sp.h)
    }
    ctx.globalAlpha = 1
  }, [])

  const draw = useCallback(() => {
    const cv = canvas.current
    const out = cv?.getContext('2d')
    const base = paintInput.current
    const h = hoverRef.current
    const input = h && h.idx >= 0 ? { ...base, focusIdx: h.idx, near: h.near } : base
    const scene = input.scene
    if (!cv || !out || !scene) return
    const dpr = window.devicePixelRatio || 1
    const { w: W, h: H } = size.current
    const moving = performance.now() - touchedAt.current < 160
    const have = layer.current
    if (input.q) return drawScene(out, input, moving, false) // searching: the picture changes with every keystroke, so draw it directly
    if (moving) {
      // Panning/zooming: no re-rasterising of thousands of links per frame (that is what made zooming slow). The bitmap drawn at rest is
      // moved and scaled instead (a little soft while it moves); one crisp repaint follows when the view has been still for a moment.
      if (have && have.scene === scene && have.dpr === dpr) {
        const v = view.current
        const s = v.k / have.lv.k
        out.setTransform(1, 0, 0, 1, 0, 0)
        out.clearRect(0, 0, cv.width, cv.height)
        out.imageSmoothingQuality = 'low'
        out.drawImage(have.cv, (v.x + (-have.mx - have.lv.x) * s) * dpr, (v.y + (-have.my - have.lv.y) * s) * dpr, have.cv.width * s, have.cv.height * s)
        return
      }
      return drawScene(out, input, true, false)
    }
    // At rest the picture is drawn once into that bitmap. Hovering then only paints it, fades it, and draws the page under the pointer on top.
    const pal = colors(cv.parentElement!)
    const v = view.current
    const key = `${cv.width}x${cv.height}|${v.x},${v.y},${v.k}|${input.curIdx}|${pal.key}`
    if (!have || have.key !== key || have.scene !== scene) {
      const mx = Math.round(W * 0.5)
      const my = Math.round(H * 0.5)
      const lc = have?.cv ?? document.createElement('canvas')
      lc.width = Math.round((W + 2 * mx) * dpr)
      lc.height = Math.round((H + 2 * my) * dpr)
      const frame = { v: { x: v.x + mx, y: v.y + my, k: v.k }, W: W + 2 * mx, H: H + 2 * my }
      drawScene(lc.getContext('2d')!, { ...input, focusIdx: -1, near: NO_SET, matches: NO_SET, q: '' }, false, false, frame)
      layer.current = { cv: lc, key, scene, lv: { ...v }, mx, my, dpr }
    }
    const L = layer.current!
    out.setTransform(1, 0, 0, 1, 0, 0)
    out.clearRect(0, 0, cv.width, cv.height)
    out.drawImage(L.cv, -L.mx * dpr, -L.my * dpr)
    if (input.focusIdx < 0) return
    out.globalCompositeOperation = 'destination-out' // fades what is drawn without painting over the stage behind the canvas
    out.fillStyle = 'rgba(0,0,0,0.8)'
    out.fillRect(0, 0, cv.width, cv.height)
    out.globalCompositeOperation = 'source-over'
    drawScene(out, input, false, true)
  }, [drawScene])

  const paint = useCallback(() => {
    try {
      draw()
    } catch (e) {
      console.error('graph view: could not draw the map', e)
    }
  }, [draw])

  const frame = useRef(0)
  const redraw = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      paint()
    })
  }, [paint])
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(glideFrame.current)
      window.clearTimeout(settle.current)
      frame.current = 0 // a cancelled frame must not stay "pending": React's dev double-mount would otherwise leave redraw() waiting for a frame that never comes
      glideFrame.current = 0
    },
    [],
  )

  // the zoom percentage re-renders the whole panel, so while zooming it is updated ten times a second at most (and once more when the view settles)
  const pctAt = useRef(0)
  const syncPct = useCallback((force?: boolean) => {
    const now = performance.now()
    if (!force && now - pctAt.current < 100) return
    pctAt.current = now
    setPct(Math.round((view.current.k / base.current) * 100))
  }, [])

  /** The view moved: draw cheaply for now, and once more in full quality when it has been still for a moment. */
  const touch = useCallback(() => {
    touchedAt.current = performance.now()
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      syncPct(true)
      redraw()
    }, 180)
  }, [redraw, syncPct])

  /** Eases the view toward `target` a bit each frame (zoom in log space, so it feels even at every scale). */
  const glide = useCallback(
    function run() {
      glideFrame.current = 0
      const v = view.current
      const t = target.current
      const f = 0.3
      const ratio = t.k / v.k
      const k = Math.abs(ratio - 1) < 0.002 ? t.k : v.k * Math.pow(ratio, f)
      const x = Math.abs(t.x - v.x) < 0.3 ? t.x : v.x + (t.x - v.x) * f
      const y = Math.abs(t.y - v.y) < 0.3 ? t.y : v.y + (t.y - v.y) * f
      view.current = { k, x, y }
      syncPct()
      touch()
      paint()
      if (k !== t.k || x !== t.x || y !== t.y) glideFrame.current = requestAnimationFrame(run)
    },
    [paint, syncPct, touch],
  )
  const moveTo = useCallback(
    (next: View) => {
      target.current = next
      moved.current = true
      if (!glideFrame.current) glideFrame.current = requestAnimationFrame(glide)
    },
    [glide],
  )

  const fit = useCallback(
    (smooth?: boolean) => {
      const s = paintInput.current.scene
      const el = stage.current
      if (el && el.clientWidth > 1 && el.clientHeight > 1) size.current = { w: el.clientWidth, h: el.clientHeight } // measured now, not the size from an earlier layout
      const { w, h } = size.current
      if (!s || !s.nodes.length) return
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity
      for (const n of s.nodes) ((x0 = Math.min(x0, n.x)), (y0 = Math.min(y0, n.y)), (x1 = Math.max(x1, n.x)), (y1 = Math.max(y1, n.y)))
      const pad = 70
      const k = Math.max(Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1), 3), 0.001)
      base.current = k
      const next = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k }
      if (smooth) {
        moveTo(next)
        moved.current = false
        return
      }
      moved.current = false
      cancelAnimationFrame(glideFrame.current)
      glideFrame.current = 0
      view.current = next
      target.current = next
      syncPct(true)
      redraw()
    },
    [redraw, syncPct, moveTo],
  )

  // canvas size follows the stage
  useEffect(() => {
    const el = stage.current
    const cv = canvas.current
    if (!el || !cv) return
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      const changed = size.current.w !== w || size.current.h !== h
      size.current = { w, h }
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = w + 'px'
      cv.style.height = h + 'px'
      if (changed && !moved.current && w > 1 && h > 1)
        fit() // the stage got its real size after the picture was fitted (opening animation, window resize)
      else redraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [redraw, scene, fit])

  useEffect(() => {
    const mo = new MutationObserver(redraw) // a theme change repaints the map in the new colours
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => mo.disconnect()
  }, [redraw])

  useEffect(fit, [scene, fit])
  useEffect(redraw, [redraw, scene, focusIdx, near, matches, curIdx, filtering])

  /** Zoom keeping the screen point (cx, cy) fixed. */
  const zoomAt = useCallback(
    (factor: number, cx = size.current.w / 2, cy = size.current.h / 2) => {
      const t = target.current // from where the view is heading, so quick repeated wheel turns add up
      const k = clamp(t.k * factor, base.current * MIN_Z, base.current * MAX_Z)
      const r = k / t.k
      moveTo({ k, x: cx - (cx - t.x) * r, y: cy - (cy - t.y) * r })
    },
    [moveTo],
  )
  keys.current = { fit: () => fit(true), zoom: (f) => zoomAt(f) }

  /** Picks a page and glides the map so it sits in the middle, close enough to read its neighbours. */
  const goTo = (id: string) => {
    setSel(id)
    const i = scene?.byId.get(id) ?? -1
    if (i < 0 || !scene) return
    const n = scene.nodes[i]
    const k = Math.max(target.current.k, base.current * 1.8)
    moveTo({ k, x: size.current.w / 2 - n.x * k, y: size.current.h / 2 - n.y * k })
    moved.current = true
  }
  /** Redraws the map around a page, `depth` links out. */
  const exploreFrom = (id: string) => (setRoot(id), setScope('local'), setSel(id))

  // the wheel listener is native so it can stop the page from scrolling
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY // a mouse wheel notch (~100) zooms ~20%, a trackpad's small deltas zoom smoothly
      zoomAt(clamp(Math.exp(-dy * 0.0018), 0.7, 1.4), e.clientX - r.left, e.clientY - r.top)
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [zoomAt, scene])

  /** The page under a point given in canvas pixels (the event's offsetX/Y: reading the canvas rectangle would force a layout on every mouse move). */
  const nodeAt = (mx: number, my: number): number => {
    const s = paintInput.current.scene
    if (!s) return -1
    const v = view.current
    const grow = radiusScale(s, v.k)
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i]
      const d = Math.hypot(v.x + n.x * v.k - mx, v.y + n.y * v.k - my)
      if (d <= baseRadius(n.deg) * grow + 4 && d < bestD) ((best = i), (bestD = d))
    }
    return best
  }

  const rootPage = (root ?? currentId) ? repo.get((root ?? currentId)!) : undefined
  const found = q ? [...matches].slice(0, 6).map((i) => nodes[i]) : []
  const num = (n: number) => n.toLocaleString(locale())
  /** One page in a side list: its colour, its title; hovering lights it on the map, clicking takes you there. */
  const row = (n: N, trailing?: ReactNode) => (
    <button
      key={n.id}
      type="button"
      className="gr-row"
      data-on={n.id === hover || undefined}
      dir={dirOf(n.title)}
      onPointerEnter={() => ((hoverRef.current = null), setHover(n.id))}
      onPointerLeave={() => ((hoverRef.current = null), setHover(null))}
      onFocus={() => ((hoverRef.current = null), setHover(n.id))}
      onBlur={() => ((hoverRef.current = null), setHover(null))}
      onClick={() => goTo(n.id)}
    >
      <span className="gr-row-ic" aria-hidden="true">
        {(() => {
          const page = repo.get(n.id)
          return page ? <PageIcon page={page} /> : <Icon name="file-text" size={14} />
        })()}
      </span>
      <span dir="auto">{n.title}</span>
      {trailing}
    </button>
  )

  return (
    <div className="gr" role="region" aria-label={t('Graph')}>
      {picked.pages.length === 0 ? (
        <div className="gr-none">
          <div className="ds-empty ds-empty--framed">
            <Icon name="graph" />
            <b>{t('No links yet')}</b>
            <span>{t('Link pages with [[ or @ and they appear here, joined by their links.')}</span>
          </div>
        </div>
      ) : (
        <div className="gr-stage" ref={stage}>
          <canvas
            ref={canvas}
            className="gr-canvas"
            data-grabbing={drag.current?.moved || undefined}
            aria-label={t('Map of {n} pages and {m} links', { n: num(picked.pages.length), m: num(picked.edges.length) })}
            role="img"
            style={hovered ? { cursor: 'var(--cursor-hand, pointer)' } : undefined}
            onPointerDown={(e) => {
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* not an active pointer (synthetic events); dragging still works while the pointer stays over the map */
              }
              drag.current = { x: e.clientX, y: e.clientY, moved: false }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d) {
                const i = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
                if (hoverRef.current ? hoverRef.current.idx === i : i < 0 && !hover) return
                const near = new Set<number>()
                if (i >= 0 && scene) for (let k = scene.adj.off[i]; k < scene.adj.off[i + 1]; k++) near.add(scene.adj.nb[k])
                hoverRef.current = { idx: i, near }
                redraw() // painted before React has re-rendered the side card
                setHover(i >= 0 ? scene!.nodes[i].id : null)
                return
              }
              const dx = e.clientX - d.x
              const dy = e.clientY - d.y
              if (!d.moved && Math.hypot(dx, dy) < 4) return
              d.moved = true
              drag.current = { x: e.clientX, y: e.clientY, moved: true }
              view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy }
              target.current = view.current // dragging follows the pointer exactly; only zoom and fit glide
              moved.current = true
              touch()
              redraw()
            }}
            onPointerUp={(e) => {
              const d = drag.current
              drag.current = null
              if (d && !d.moved) {
                const i = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
                setSel(i >= 0 ? scene!.nodes[i].id : null)
              }
            }}
            onPointerLeave={() => ((drag.current = null), (hoverRef.current = { idx: -1, near: NO_SET }), redraw(), setHover(null))}
            onDoubleClick={() => fit(true)}
          />
          {!scene && (
            <div className="gr-loading" role="status">
              {t('Arranging the map…')}
            </div>
          )}

          {/* find and narrow: search, what is drawn, tags */}
          <div className="gr-panel gr-find">
            <SearchField
              value={query}
              onChange={setQuery}
              onEnter={() => found[0] && goTo(found[0].id)}
              label={t('Find a page')}
              placeholder={t('Find a page…')}
              clearLabel={t('Clear')}
              className="gr-search"
            />
            {q && (
              <div className="gr-found" role="list" aria-label={t('{n} pages found', { n: num(matches.size) })}>
                {found.length ? found.map((n) => row(n)) : <p className="gr-note">{t('No page with that name is on the map')}</p>}
                {matches.size > found.length && <p className="gr-note">{t('{n} more lit on the map', { n: num(matches.size - found.length) })}</p>}
              </div>
            )}
            <div className="ds-seg gr-scope" role="group" aria-label={t('Show')}>
              <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                {t('Whole workspace')}
              </button>
              <button type="button" aria-pressed={scope === 'local'} disabled={!rootPage} onClick={() => setScope('local')}>
                {t('Around a page')}
              </button>
            </div>
            {scope === 'local' && rootPage && (
              <div className="gr-around">
                <span className="gr-around-page" dir="auto">
                  {rootPage.title || t('Untitled')}
                </span>
                <div className="ds-seg" role="group" aria-label={t('Links away')}>
                  {([1, 2, 3] as const).map((d) => (
                    <button key={d} type="button" aria-pressed={depth === d} title={t('{n} links away', { n: d })} onClick={() => setDepth(d)}>
                      {num(d)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tags.length > 0 && (
              <div className="gr-tags" role="group" aria-label={t('Light up a tag')}>
                {tags.map((x) => (
                  <ChipButton key={x} aria-pressed={tag === x} icon={<Icon name="hash" size={12} />} onClick={() => setTag(tag === x ? null : x)}>
                    <span dir="auto">{x}</span>
                  </ChipButton>
                ))}
              </div>
            )}
            <EdgeKindToggles kinds={kinds} onChange={setKinds} />
          </div>

          {/* the picked page and its links both ways; with nothing picked, the most connected pages */}
          <aside className="gr-panel gr-card" aria-label={selNode ? selNode.title : t('Most connected')}>
            {selNode ? (
              <>
                <div className="gr-card-head" dir={dirOf(selNode.title)}>
                  <span className="gr-card-ic">{selPage ? <PageIcon page={selPage} /> : <Icon name="file-text" />}</span>
                  <span className="gr-card-title">
                    <b dir="auto">{selNode.title}</b>
                    <small>{t(selNode.deg === 1 ? '1 link' : '{n} links', { n: num(selNode.deg) })}</small>
                  </span>
                  <IconButton label={t('Close')} onClick={() => setSel(null)}>
                    <Icon name="x" size={16} />
                  </IconButton>
                </div>
                {selPage?.tags?.length ? (
                  <div className="gr-card-tags">
                    {selPage.tags.map((x) => (
                      <Tag key={x} label={x} />
                    ))}
                  </div>
                ) : null}
                <div className="gr-card-acts">
                  <Button variant="primary" size="sm" icon={<Icon name="arrow-up-right" size={15} className="ds-flip" />} onClick={() => onOpen(selNode.id)}>
                    {t('Open page')}
                  </Button>
                  <Button size="sm" icon={<Icon name="graph" size={15} />} onClick={() => exploreFrom(selNode.id)} disabled={scope === 'local' && root === selNode.id}>
                    {t('Explore from here')}
                  </Button>
                </div>
                <div className="gr-lists">
                  <section aria-labelledby="gr-to">
                    <h3 id="gr-to">
                      {t('Links to')} <span>{num(conn.to.length)}</span>
                    </h3>
                    {conn.to.length ? conn.to.map((n) => row(n)) : <p className="gr-note">{t('This page links to no other page')}</p>}
                  </section>
                  <section aria-labelledby="gr-from">
                    <h3 id="gr-from">
                      {t('Linked from')} <span>{num(conn.from.length)}</span>
                    </h3>
                    {conn.from.length ? conn.from.map((n) => row(n)) : <p className="gr-note">{t('No page links here yet')}</p>}
                  </section>
                </div>
              </>
            ) : (
              <>
                <h3 className="gr-card-sec">{t('Most connected')}</h3>
                <div className="gr-lists">{top.map((n) => row(n, <em>{num(n.deg)}</em>))}</div>
                <p className="gr-note">{t('Pick a page on the map to see what it links to and what links to it.')}</p>
              </>
            )}
          </aside>

          <div className="gr-panel gr-zoom">
            <IconButton label={t('Zoom out') + '  −'} onClick={() => zoomAt(1 / 1.3)}>
              <Icon name="minus" size={16} />
            </IconButton>
            <span className="gr-pct" aria-live="polite">
              {num(pct)}%
            </span>
            <IconButton label={t('Zoom in') + '  +'} onClick={() => zoomAt(1.3)}>
              <Icon name="plus" size={16} />
            </IconButton>
            <IconButton label={t('Fit to screen') + '  F'} onClick={() => fit(true)}>
              <Icon name="maximize" size={16} />
            </IconButton>
          </div>

          <Stats
            className="gr-panel gr-stats"
            label={t('Map')}
            items={[
              { label: t(picked.pages.length === 1 ? 'page' : 'pages'), value: num(picked.pages.length) },
              { label: t(picked.edges.length === 1 ? 'link' : 'links'), value: num(picked.edges.length) },
              ...(scope === 'all' && picked.unlinked > 0 ? [{ label: t('without links'), value: num(picked.unlinked) }] : []),
            ]}
          />
        </div>
      )}
    </div>
  )
}
