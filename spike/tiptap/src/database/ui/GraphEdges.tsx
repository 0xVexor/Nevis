// Typed edges for the page graph: relations, dependencies and sub-items of databases, drawn on top of the page links. Off by default;
// the selection runs in the database domain (graph.ts) so permissions and the 500 / 3000 budget apply in one place.
import { useMemo, useSyncExternalStore } from 'react'
import { repo } from '../../store'
import { peekDatabase } from '../runtime'
import { GRAPH_LIMITS, selectGraph, type GraphEdgeKind } from '../graph.ts'
import { t } from '../../i18n'

export type ExtraKinds = { relation: boolean; dependency: boolean; hierarchy: boolean }
const noSub = () => () => {}

export function useDatabaseEdges(kinds: ExtraKinds): [string, string][] {
  const svc = peekDatabase()
  const version = useSyncExternalStore(svc ? svc.subscribe : noSub, svc ? svc.getVersion : () => 0)
  return useMemo(() => {
    const edgeKinds = (Object.keys(kinds) as GraphEdgeKind[]).filter((k) => kinds[k as keyof ExtraKinds])
    if (!svc || !edgeKinds.length) return []
    const pages = repo.pagesOnly().map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, deletedAt: p.deletedAt }))
    const r = selectGraph(svc.state, pages, [], { vaultId: svc.vaultId, hops: 0, edgeKinds, maxNodes: GRAPH_LIMITS.maxNodes * 6, maxEdges: GRAPH_LIMITS.maxEdges, principalId: svc.principalId })
    return r.edges.map((e) => [e.fromPageId, e.toPageId] as [string, string])
  }, [svc, version, kinds.relation, kinds.dependency, kinds.hierarchy]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function EdgeKindToggles({ kinds, onChange }: { kinds: ExtraKinds; onChange: (k: ExtraKinds) => void }) {
  if (!peekDatabase()) return null
  const item = (k: keyof ExtraKinds, label: string) => (
    <label key={k} className="gv-kind"><input type="checkbox" checked={kinds[k]} onChange={(e) => onChange({ ...kinds, [k]: e.target.checked })} /> {t(label)}</label>
  )
  return <div className="gv-kinds" role="group" aria-label={t('Database links')}>{item('relation', 'Relations')}{item('dependency', 'Dependencies')}{item('hierarchy', 'Sub-items')}</div>
}
