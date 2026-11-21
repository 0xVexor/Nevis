import { useState } from 'react'
import type { PageNode } from '@nevis/core'
import type { Workspace } from './workspace'

const ROOT_CAP = 200
interface Props { ws: Workspace; selected: string; onSelect: (id: string) => void }

/** The collapsed-by-default page tree: only expanded branches are in the DOM, so 10 000 pages cost 50 rows at startup. */
export function PageTreeView({ ws, selected, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [rootCap, setRootCap] = useState(ROOT_CAP)
  const toggle = (id: string) => setOpen(o => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const row = (n: PageNode): React.ReactNode => {
    const id = n.page.id
    const expanded = open.has(id) || (selected !== '' && isAncestor(ws, id, selected))
    return (
      <li key={id}>
        <div className={`row ${id === selected ? 'sel' : ''}`} data-testid="page-row" data-id={id}>
          <button className="twist" aria-label="باز/بسته" onClick={() => toggle(id)} disabled={!n.children.length}>{n.children.length ? (expanded ? '▾' : '◂') : '·'}</button>
          <button className="title" onClick={() => onSelect(id)}>{n.page.type === 'database' ? '▦ ' : ''}{n.page.title || 'بدون عنوان'}</button>
        </div>
        {expanded && n.children.length > 0 && <ul>{n.children.map(row)}</ul>}
      </li>
    )
  }
  // A flat workspace (an import, 10 000 root pages) must not put every root in the DOM: the first ROOT_CAP, then "show more".
  const shown = ws.tree.roots.slice(0, rootCap)
  return (
    <ul className="tree" data-testid="tree">
      {shown.map(row)}
      {ws.tree.roots.length > rootCap && <li><button data-testid="tree-more" className="title" onClick={() => setRootCap(c => c + ROOT_CAP)}>نمایش بیشتر ({ws.tree.roots.length - rootCap})</button></li>}
    </ul>
  )
}

function isAncestor(ws: Workspace, ancestor: string, id: string): boolean {
  for (let cur = ws.tree.parentOf.get(id) ?? '', n = 0; cur !== '' && n < 10_000; cur = ws.tree.parentOf.get(cur) ?? '', n++) if (cur === ancestor) return true
  return false
}
