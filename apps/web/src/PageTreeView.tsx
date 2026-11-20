import { useState } from 'react'
import type { PageNode } from '@nevis/core'
import type { Workspace } from './workspace'

interface Props { ws: Workspace; selected: string; onSelect: (id: string) => void }

/** The collapsed-by-default page tree: only expanded branches are in the DOM, so 10 000 pages cost 50 rows at startup. */
export function PageTreeView({ ws, selected, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setOpen(o => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const row = (n: PageNode): React.ReactNode => {
    const id = n.page.id
    const expanded = open.has(id) || (selected !== '' && isAncestor(ws, id, selected))
    return (
      <li key={id}>
        <div className={`row ${id === selected ? 'sel' : ''}`} data-testid="page-row" data-id={id}>
          <button className="twist" aria-label="باز/بسته" onClick={() => toggle(id)} disabled={!n.children.length}>{n.children.length ? (expanded ? '▾' : '◂') : '·'}</button>
          <button className="title" onClick={() => onSelect(id)}>{n.page.title || 'بدون عنوان'}</button>
        </div>
        {expanded && n.children.length > 0 && <ul>{n.children.map(row)}</ul>}
      </li>
    )
  }
  return <ul className="tree" data-testid="tree">{ws.tree.roots.map(row)}</ul>
}

function isAncestor(ws: Workspace, ancestor: string, id: string): boolean {
  for (let cur = ws.tree.parentOf.get(id) ?? '', n = 0; cur !== '' && n < 10_000; cur = ws.tree.parentOf.get(cur) ?? '', n++) if (cur === ancestor) return true
  return false
}
