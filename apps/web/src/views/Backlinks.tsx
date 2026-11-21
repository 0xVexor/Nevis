import { go } from '../router'
import type { Workspace } from '../workspace'

/** Pages that link here. Found by the target's id, so renaming this page keeps every backlink and shows the new title. */
export function Backlinks({ ws, id }: { ws: Workspace; id: string }) {
  const titles = new Map(ws.data.pages.map(p => [p.id, p.title || 'بدون عنوان']))
  const from = ws.search.backlinks(id)
  if (!from.length) return null
  return (
    <aside className="backlinks" data-testid="backlinks" dir="rtl">
      <h2>پیوندهای ورودی</h2>
      <ul>{from.map(src => <li key={src}><a data-testid="backlink" href={`#/page/${src}`} onClick={e => { e.preventDefault(); go({ name: 'page', id: src }) }}>{titles.get(src)}</a></li>)}</ul>
    </aside>
  )
}
