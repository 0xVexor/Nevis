// Typed graph selector (handoff §20): nodes + typed edges, bounded, deterministic, permission-aware. The default graph stays
// mention-only; relations, dependencies and sub-item hierarchy are opt-in by kind / source / property.
import type { Id } from './model/types.ts'
import { Access } from './access.ts'
import type { DbState } from './state.ts'

export type GraphEdgeKind = 'mention' | 'relation' | 'dependency' | 'hierarchy'
export type GraphEdge = { id: Id; fromPageId: Id; toPageId: Id; kind: GraphEdgeKind; propertyId?: Id; directed: boolean }
export type GraphQuery = {
  vaultId: Id
  rootPageId?: Id
  hops: 0 | 1 | 2
  edgeKinds: GraphEdgeKind[]
  sourceIds?: Id[]
  propertyIds?: Id[]
  maxNodes: number
  maxEdges: number
  principalId: Id
}
export type GraphNode = { id: Id; title: string; degree: number; sourceId: Id | null; icon?: string }
export type GraphResult = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: { nodes: boolean; edges: boolean }
  totalNodes: number
  totalEdges: number
  rootRetained: boolean
  /** page ids that matched but were cut by the budget, so search can refocus instead of saying "not found" */
  cutIds: Id[]
}

export const GRAPH_LIMITS = { maxNodes: 500, maxEdges: 3000 }

export type PageSummary = { id: Id; title: string; icon?: string; kind?: string; deletedAt: number | null }

export function selectGraph(state: DbState, pages: PageSummary[], mentions: [Id, Id][], q: GraphQuery): GraphResult {
  const access = new Access(state)
  const visible = new Map<Id, PageSummary>()
  // a database's host page is only visible to someone who can read at least one of its sources
  const hostSources = new Map<Id, Id[]>()
  for (const c of state.live('container')) hostSources.set(c.hostPageId, [...(hostSources.get(c.hostPageId) ?? []), ...c.sourceLinks.map((l) => l.sourceId)])
  for (const p of pages) {
    if (p.deletedAt !== null || p.kind === 'folder') continue
    const hs = hostSources.get(p.id)
    if (hs && !hs.some((sid) => access.sourceCaps(q.principalId, sid).has('read'))) continue
    const row = state.row(p.id)
    if (row && !access.canSeeRow(q.principalId, row)) continue // trashed / inaccessible nodes vanish without leaking their label
    visible.set(p.id, p)
  }
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const add = (e: GraphEdge) => {
    if (!visible.has(e.fromPageId) || !visible.has(e.toPageId)) return
    if (seen.has(e.id)) return
    seen.add(e.id)
    edges.push(e)
  }
  const kinds = new Set(q.edgeKinds)
  if (kinds.has('mention')) for (const [a, b] of mentions) if (a !== b) add({ id: `m:${a}>${b}`, fromPageId: a, toPageId: b, kind: 'mention', directed: true })
  const sourceOk = (sid: Id) => !q.sourceIds || q.sourceIds.includes(sid)
  if (kinds.has('relation') || kinds.has('dependency')) {
    for (const e of state.live('edge')) {
      const rel = state.get('relation', e.definitionId)
      if (!rel || rel.deletedAt !== null) continue
      if (!sourceOk(rel.sourceId) && !sourceOk(rel.targetSourceId)) continue
      if (q.propertyIds && !q.propertyIds.includes(rel.propertyId)) continue
      const src = state.get('source', rel.sourceId)
      const isDep = (src?.settings as { dependencyRelationId?: Id } | undefined)?.dependencyRelationId === rel.id
      const kind: GraphEdgeKind = isDep ? 'dependency' : 'relation'
      if (!kinds.has(kind)) continue
      // one logical edge per canonical record: a two-way relation is a single edge, never double weight
      add({ id: e.id, fromPageId: e.fromPageId, toPageId: e.toPageId, kind, propertyId: rel.propertyId, directed: rel.mode !== 'self_symmetric' })
    }
  }
  if (kinds.has('hierarchy')) {
    for (const row of state.snapshot().rowByPage.values()) {
      if (!row.ext.parentItemId || !sourceOk(row.sourceId)) continue
      add({ id: `h:${row.page.id}`, fromPageId: row.ext.parentItemId, toPageId: row.page.id, kind: 'hierarchy', directed: true })
    }
  }

  const adj = new Map<Id, Set<Id>>()
  const link = (a: Id, b: Id) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
  for (const e of edges) (link(e.fromPageId, e.toPageId), link(e.toPageId, e.fromPageId))
  const degreeAll = (id: Id) => adj.get(id)?.size ?? 0

  // node set: global, or BFS from the root with deterministic neighbour order (visible degree desc, then id)
  const order: Id[] = []
  const keep = new Set<Id>()
  if (q.rootPageId && visible.has(q.rootPageId)) {
    keep.add(q.rootPageId)
    order.push(q.rootPageId)
    let frontier = [q.rootPageId]
    for (let h = 0; h < q.hops; h++) {
      const next: Id[] = []
      for (const n of frontier) {
        const nb = [...(adj.get(n) ?? [])].filter((x) => !keep.has(x)).sort((a, b) => degreeAll(b) - degreeAll(a) || (a < b ? -1 : 1))
        for (const x of nb) if (!keep.has(x)) (keep.add(x), order.push(x), next.push(x))
      }
      frontier = next
    }
  } else {
    const all = [...visible.keys()].sort((a, b) => degreeAll(b) - degreeAll(a) || (a < b ? -1 : 1))
    for (const id of all) (keep.add(id), order.push(id))
  }
  const totalNodes = keep.size
  let nodeIds = order
  const cut: Id[] = []
  if (nodeIds.length > q.maxNodes) {
    const root = q.rootPageId && keep.has(q.rootPageId) ? q.rootPageId : null
    const rest = nodeIds.filter((x) => x !== root)
    const take = rest.slice(0, q.maxNodes - (root ? 1 : 0))
    cut.push(...rest.slice(take.length))
    nodeIds = root ? [root, ...take] : take
  }
  const inSet = new Set(nodeIds)
  let outEdges = edges.filter((e) => inSet.has(e.fromPageId) && inSet.has(e.toPageId))
  const totalEdges = outEdges.length
  if (outEdges.length > q.maxEdges) outEdges = outEdges.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, q.maxEdges)
  const deg = new Map<Id, number>()
  for (const e of outEdges) {
    deg.set(e.fromPageId, (deg.get(e.fromPageId) ?? 0) + 1)
    deg.set(e.toPageId, (deg.get(e.toPageId) ?? 0) + 1)
  }
  const nodes: GraphNode[] = nodeIds.map((id) => {
    const p = visible.get(id)!
    return { id, title: p.title, degree: deg.get(id) ?? 0, sourceId: state.row(id)?.sourceId ?? null, ...(p.icon ? { icon: p.icon } : {}) }
  })
  return {
    nodes, edges: outEdges, truncated: { nodes: totalNodes > nodes.length, edges: totalEdges > outEdges.length }, totalNodes, totalEdges,
    rootRetained: !q.rootPageId || nodes.some((n) => n.id === q.rootPageId), cutIds: cut,
  }
}
