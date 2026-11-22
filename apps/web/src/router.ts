// A tiny hash router: `#/home`, `#/all`, `#/templates`, `#/settings`, `#/page/<id>`. The hash keeps every screen linkable and the back button working,
// and needs nothing from the server.
import { useSyncExternalStore } from 'react'

export type Route = { name: 'home' | 'all' | 'templates' | 'settings' | 'graph' | 'tasks' | 'trash' | 'cards' | 'databases' | 'drawings' | 'files' } | { name: 'page'; id: string } | { name: 'row'; db: string; id: string }

export function parse(hash: string): Route {
  const [, a, b] = /^#\/?([^/]*)\/?(.*)$/.exec(hash) ?? []
  if (a === 'page' && b) return { name: 'page', id: decodeURIComponent(b) }
  if (a === 'row' && b) { const [db, id] = b.split('/'); if (db && id) return { name: 'row', db: decodeURIComponent(db), id: decodeURIComponent(id) } }
  if (a === 'all' || a === 'templates' || a === 'settings' || a === 'graph' || a === 'tasks' || a === 'trash' || a === 'cards' || a === 'databases' || a === 'drawings' || a === 'files') return { name: a }
  return { name: 'home' }
}
export const href = (r: Route): string => (r.name === 'page' ? `#/page/${encodeURIComponent(r.id)}` : r.name === 'row' ? `#/row/${encodeURIComponent(r.db)}/${encodeURIComponent(r.id)}` : `#/${r.name}`)
export const go = (r: Route) => { location.hash = href(r) }

const subscribe = (cb: () => void) => { addEventListener('hashchange', cb); return () => removeEventListener('hashchange', cb) }
export const useRoute = (): Route => {
  const hash = useSyncExternalStore(subscribe, () => location.hash)
  return parse(hash)
}
