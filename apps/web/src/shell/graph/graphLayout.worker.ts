import { layoutGraph } from './graphForce'

self.onmessage = (e: MessageEvent<{ n: number; edges: Int32Array }>) => {
  const out = layoutGraph(e.data.n, e.data.edges)
  ;(self as unknown as Worker).postMessage(out, [out.xy.buffer])
}
