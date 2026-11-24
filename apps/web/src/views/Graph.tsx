// The map of pages and the links between them: the old app's graph (canvas, layout worker, around-a-page and whole-workspace views),
// fed from the link index of the new data layer.
import { useMemo } from 'react'
import { go } from '../router'
import { legacyPages } from '../shell/adapt'
import { GraphView } from '../shell/graph/GraphView'
import type { Workspace } from '../workspace'

export function Graph({ ws, currentId }: { ws: Workspace; currentId?: string }) {
  const pages = useMemo(() => legacyPages(ws).filter(p => !p.deletedAt), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => ws.search.edges().map(e => [e.from, e.to] as [string, string]), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const relations = useMemo(() => {
    const rows = new Map<string, { db: string; page: (typeof pages)[number] }>()
    for (const db of ws.data.databases.values()) {
      if (db.trashed) continue
      for (const row of db.rows) if (!row.trashed) rows.set(row.id, { db: db.id, page: {
        id: row.id, title: row.title, parentId: db.id, favorite: false, sort: 0,
        content: null, updatedAt: row.createdAt, deletedAt: null,
      } })
    }
    const edges: [string, string][] = []
    for (const db of ws.data.databases.values()) {
      if (db.trashed) continue
      for (const prop of db.properties) {
        if (prop.trashed || prop.type !== 'relation') continue
        const target = prop.config && typeof prop.config === 'object' && !Array.isArray(prop.config) && typeof prop.config.target === 'string' ? prop.config.target : db.id
        for (const row of db.rows) {
          if (row.trashed) continue
          const value = row.cells[prop.id]
          if (!Array.isArray(value)) continue
          for (const id of value) if (rows.get(id)?.db === target) edges.push([row.id, id])
        }
      }
    }
    return { rows, edges }
  }, [ws.data])
  return (
    <div data-testid="graph" style={{ display: 'contents' }}>
      <GraphView currentId={currentId} pages={pages} edges={edges} relationPages={[...relations.rows.values()].map(r => r.page)} relationEdges={relations.edges} onOpen={id => { const row = relations.rows.get(id); go(row ? { name: 'row', db: row.db, id } : { name: 'page', id }) }} onClose={() => go({ name: 'home' })} />
    </div>
  )
}
