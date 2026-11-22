// The new data layer seen through the shapes the shell's screens were written for (shell/model.ts).
import type { PageRow } from '@nevis/core'
import type { Page, Task } from './model'
import type { Workspace } from '../workspace'

/** Every page and database of the workspace (trashed ones carry `deletedAt`), siblings numbered in their order. */
/** `hideInbox`: the Inbox is a page the tree and the lists do not show (the Tasks screen reads its checklist directly). */
export function legacyPages(ws: Workspace, hideInbox = true): Page[] {
  const rows: PageRow[] = ws.data.pages
  const byParent = new Map<string, PageRow[]>()
  for (const p of rows) { const l = byParent.get(p.parent) ?? []; l.push(p); byParent.set(p.parent, l) }
  const rank = new Map<string, number>()
  for (const l of byParent.values()) { l.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1)); l.forEach((p, i) => rank.set(p.id, i)) }
  const known = new Set(rows.map(p => p.id))
  const tagName = new Map(ws.data.tags.map(t => [t.id, t.name]))
  const inbox = typeof ws.data.settings.inbox === 'string' ? ws.data.settings.inbox : ''
  return rows.filter(p => p.id !== inbox || !hideInbox).map(p => {
    const text = ws.search.excerptOf(p.id)
    return {
      kind: ws.isFolder(p.id) ? 'folder' : ws.isTodoList(p.id) ? 'todo' : ws.isBoard(p.id) ? 'board' : undefined, id: p.id, icon: p.icon || undefined, status: (p.status || undefined) as Page['status'], favorite: !!p.favorite, cover: coverOf(p.cover), tags: (ws.data.pageTags.get(p.id) ?? []).map(i => tagName.get(i) ?? '').filter(Boolean), words: ws.search.wordsOf(p.id), parentId: p.parent && known.has(p.parent) ? p.parent : null, title: p.title, sort: rank.get(p.id) ?? 0,
      content: { type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] },
      updatedAt: ws.search.touchedAt(p.id) || p.createdAt, deletedAt: p.trashed ? (p.trashedAt || p.createdAt) : null,
    } satisfies Page
  })
}

function coverOf(raw: string | undefined): Page['cover'] { try { const v = raw ? JSON.parse(raw) : null; return v && typeof v === 'object' ? v : undefined } catch { return undefined } }

export function legacyTasks(ws: Workspace): Task[] {
  const out: Task[] = []
  const count = new Map<string, number>()
  const created = new Map(ws.data.pages.map(page => [page.id, page.createdAt]))
  for (const { page, task } of ws.search.tasks()) { const i = count.get(page) ?? 0; count.set(page, i + 1); out.push({ pageId: page, index: i, text: task.text, checked: task.checked, depth: 0 }) }
  // Worker completion order must not reorder the Home task list. The old repo listed pages in creation order.
  return out.sort((a, b) => (created.get(a.pageId) ?? 0) - (created.get(b.pageId) ?? 0) || a.pageId.localeCompare(b.pageId) || a.index - b.index)
}
