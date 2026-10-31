// Typed edges for the page graph: relations, dependencies and sub-items of databases, drawn on top of the page links. Off by default;
// the selection runs in the database domain (graph.ts) so permissions and the 500 / 3000 budget apply in one place.
import { useMemo, useSyncExternalStore } from 'react'
import { repo } from '../../store'
import { peekDatabase } from '../runtime'
import { GRAPH_LIMITS, selectGraph, type GraphEdgeKind } from '../graph.ts'
import { t } from '../../i18n'

export type ExtraKinds = { relation: boolean; dependency: boolean; hierarchy: boolean }
const noSub = () => () => {}

function edgesOf(svc: NonNullable<ReturnType<typeof peekDatabase>>, edgeKinds: GraphEdgeKind[]): [string, string][] {
  const pages = repo.pagesOnly().map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, deletedAt: p.deletedAt }))
  const r = selectGraph(svc.state, pages, [], { vaultId: svc.vaultId, hops: 0, edgeKinds, maxNodes: GRAPH_LIMITS.maxNodes * 6, maxEdges: GRAPH_LIMITS.maxEdges, principalId: svc.principalId })
  return r.edges.map((e) => [e.fromPageId, e.toPageId] as [string, string])
}

export function useDatabaseEdges(kinds: ExtraKinds): [string, string][] {
  const svc = peekDatabase()
  const version = useSyncExternalStore(svc ? svc.subscribe : noSub, svc ? svc.getVersion : () => 0)
  return useMemo(() => {
    const edgeKinds = (Object.keys(kinds) as GraphEdgeKind[]).filter((k) => kinds[k as keyof ExtraKinds])
    return svc && edgeKinds.length ? edgesOf(svc, edgeKinds) : []
  }, [svc, version, kinds.relation, kinds.dependency, kinds.hierarchy]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** How many links of each kind the vault has, so a toggle with nothing behind it can say so. */
function useKindCounts(): Record<keyof ExtraKinds, number> {
  const svc = peekDatabase()
  const version = useSyncExternalStore(svc ? svc.subscribe : noSub, svc ? svc.getVersion : () => 0)
  return useMemo(() => {
    const n = (k: GraphEdgeKind) => (svc ? edgesOf(svc, [k]).length : 0)
    return { relation: n('relation'), dependency: n('dependency'), hierarchy: n('hierarchy') }
  }, [svc, version])
}

export function EdgeKindToggles({ kinds, onChange }: { kinds: ExtraKinds; onChange: (k: ExtraKinds) => void }) {
  const counts = useKindCounts()
  if (!peekDatabase()) return null
  const item = (k: keyof ExtraKinds, label: string) => (
    <button key={k} type="button" disabled={counts[k] === 0} title={counts[k] === 0 ? t('No links of this kind in your databases yet') : undefined} className={'gv-kind' + (kinds[k] && counts[k] ? ' on' : '')} aria-pressed={kinds[k] && counts[k] > 0} onClick={() => onChange({ ...kinds, [k]: !kinds[k] })}>{kinds[k] && counts[k] > 0 && <svg className="ds-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7" /></svg>}{t(label)}{counts[k] > 0 && <em>{counts[k]}</em>}</button>
  )
  return <div className="gv-kinds" role="group" aria-label={t('Database links')}>{item('relation', 'Relations')}{item('dependency', 'Dependencies')}{item('hierarchy', 'Sub-items')}</div>
}
