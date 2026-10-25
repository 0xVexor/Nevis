// Every drawing in the workspace: Board pages, and Drawing blocks inside ordinary pages.
import { repo } from './store'

export interface DrawingInfo {
  key: string
  pageId: string
  title: string // page title
  source: 'board' | 'inline'
  preview: string // attachment id of the SVG picture ('' = nothing drawn yet)
  updatedAt: number
}

function drawingNodes(node: any, out: any[] = []): any[] {
  if (!node) return out
  if (node.type === 'drawing') out.push(node)
  for (const c of node.content ?? []) drawingNodes(c, out)
  return out
}

/** Drops the index-th drawing block from a page (same order as allDrawings); returns the previous content so the caller can undo. */
export function removeInlineDrawing(pageId: string, index: number): any | null {
  const p = repo.get(pageId)
  if (!p || typeof p.content === 'string') return null
  const before = p.content
  const next = structuredClone(before)
  let seen = 0
  const strip = (node: any): void => {
    if (!node.content) return
    node.content = node.content.filter((c: any) => !(c.type === 'drawing' && seen++ === index))
    node.content.forEach(strip)
  }
  strip(next)
  if (!next.content?.length) next.content = [{ type: 'paragraph' }]
  repo.update(pageId, { content: next })
  return before
}

export function allDrawings(): DrawingInfo[] {
  const out: DrawingInfo[] = []
  for (const p of repo.pagesOnly()) {
    if (typeof p.content === 'string') continue
    const nodes = drawingNodes(p.content)
    nodes.forEach((n, i) => {
      const preview = n.attrs?.preview ?? ''
      // an empty drawing inside a page is only a placeholder; an empty board is still listed so it can be opened
      if (!preview && p.kind !== 'board') return
      out.push({ key: `${p.id}:${i}`, pageId: p.id, title: p.title, source: p.kind === 'board' ? 'board' : 'inline', preview, updatedAt: p.updatedAt })
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
