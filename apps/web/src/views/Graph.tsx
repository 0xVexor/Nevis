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
  return (
    <div data-testid="graph" style={{ display: 'contents' }}>
      <GraphView currentId={currentId} pages={pages} edges={edges} onOpen={id => go({ name: 'page', id })} onClose={() => go({ name: 'home' })} />
    </div>
  )
}
