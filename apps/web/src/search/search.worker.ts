// The search index lives here, off the main thread (ADR-0010): building it for thousands of pages takes seconds.
import { SearchIndex, type SearchDoc } from '@nevis/search'

type Msg =
  | { id: number; t: 'load'; text: string }
  | { id: number; t: 'add'; docs: SearchDoc[] }
  | { id: number; t: 'remove'; ids: string[] }
  | { id: number; t: 'search'; q: string; limit: number }
  | { id: number; t: 'dump' }

let index = new SearchIndex()
self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data
  let out: unknown = null
  switch (m.t) {
    case 'load': { const i = SearchIndex.load(m.text); if (i) index = i; out = !!i; break }
    case 'add': for (const d of m.docs) index.set(d); out = index.size; break
    case 'remove': for (const id of m.ids) index.remove(id); out = index.size; break
    case 'search': out = index.search(m.q, m.limit); break
    case 'dump': out = index.serialize(); break
  }
  ;(self as unknown as Worker).postMessage({ id: m.id, out })
}
