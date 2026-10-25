import { layoutGraph, type Layout } from './graphForce'
import { kvGet, kvSet } from './db'

export type { Layout }

const ALGORITHM = 2 // bump when graphForce changes, so old cached pictures are not reused
const KEEP = 4 // cached layouts (whole vault, a few local maps)
const KV = 'graphLayouts'

interface Saved {
  key: string
  w: number
  h: number
  xy: string // base64 of the Float32Array
}

/** The picture depends only on the number of pages and on the links between them (the layout is deterministic). */
function keyOf(n: number, edges: Int32Array): string {
  let h = 2166136261 ^ ALGORITHM
  for (let i = 0; i < edges.length; i++) h = Math.imul(h ^ edges[i], 16777619)
  return `${n}:${edges.length}:${(h >>> 0).toString(36)}`
}

const toB64 = (a: Float32Array) => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string) => {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

const compute = (n: number, edges: Int32Array): Promise<Layout> => {
  if (typeof Worker === 'undefined') return Promise.resolve(layoutGraph(n, edges))
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./graphLayout.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      return resolve(layoutGraph(n, edges))
    }
    worker.onmessage = (e: MessageEvent<Layout>) => (worker.terminate(), resolve(e.data))
    worker.onerror = () => (worker.terminate(), resolve(layoutGraph(n, edges)))
    worker.postMessage({ n, edges: edges.slice() })
  })
}

/** Lays the graph out off the main thread, and remembers the result so opening the same map again is instant. */
export async function layoutAsync(n: number, edges: Int32Array): Promise<Layout> {
  const key = keyOf(n, edges)
  let saved: Saved[] = []
  try {
    const raw = await kvGet<Saved[]>(KV)
    if (Array.isArray(raw)) saved = raw
    const hit = saved.find((s) => s.key === key)
    if (hit) return { xy: fromB64(hit.xy), w: hit.w, h: hit.h }
  } catch {
    /* no cache: just compute */
  }
  const l = await compute(n, edges)
  try {
    await kvSet(KV, [{ key, w: l.w, h: l.h, xy: toB64(l.xy) }, ...saved.filter((s) => s.key !== key)].slice(0, KEEP))
  } catch {
    /* the cache is an optimisation only */
  }
  return l
}
