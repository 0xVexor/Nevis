// The new data layer seen through the shapes the shell's screens were written for (shell/model.ts).
import type { PageRow } from '@nevis/core'
import type { Page, Task } from './model'
import type { Workspace } from '../workspace'

/** Every page and database of the workspace (trashed ones carry `deletedAt`), siblings numbered in their order. */
export function legacyPages(ws: Workspace): Page[] {
  const rows: PageRow[] = ws.data.pages
  const byParent = new Map<string, PageRow[]>()
  for (const p of rows) { const l = byParent.get(p.parent) ?? []; l.push(p); byParent.set(p.parent, l) }
  const rank = new Map<string, number>()
  for (const l of byParent.values()) { l.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1)); l.forEach((p, i) => rank.set(p.id, i)) }
  const known = new Set(rows.map(p => p.id))
  return rows.map(p => {
    const text = ws.search.excerptOf(p.id)
    return {
      id: p.id, parentId: p.parent && known.has(p.parent) ? p.parent : null, title: p.title, favorite: false, sort: rank.get(p.id) ?? 0,
      content: { type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] },
      updatedAt: ws.search.touchedAt(p.id) || p.createdAt, deletedAt: p.trashed ? p.createdAt : null,
    } satisfies Page
  })
}

export function legacyTasks(ws: Workspace): Task[] {
  const out: Task[] = []
  const count = new Map<string, number>()
  for (const { page, task } of ws.search.tasks()) { const i = count.get(page) ?? 0; count.set(page, i + 1); out.push({ pageId: page, index: i, text: task.text, checked: task.checked, depth: 0 }) }
  return out
}
